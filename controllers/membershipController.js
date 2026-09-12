/**
 * Membership plans (Zenoti "Manage memberships") and the guests who hold them.
 */
const mongoose = require('mongoose');
const Membership = require('../models/Membership');
const MembershipAssignment = require('../models/MembershipAssignment');
const User = require('../models/User');
const Consultation = require('../models/Consultation');
const { syncUserMembership, currentMembership } = require('../utils/membershipRules');

const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ''));
const fail = (res, status, message, extra = {}) => res.status(status).json({ success: false, message, ...extra });
const who = (req) => req.admin?.name || req.admin?.email || 'Admin';

async function cleanCredits(list) {
  const out = [];
  for (const c of Array.isArray(list) ? list : []) {
    if (!c || !c.serviceId) continue;
    let svc = await Consultation.findOne({ id: c.serviceId }).select('id name').lean();
    if (!svc && isId(c.serviceId)) svc = await Consultation.findById(c.serviceId).select('id name').lean();
    out.push({ serviceId: svc?.id || String(c.serviceId), serviceName: svc?.name || c.serviceName || '', qty: Math.max(1, Number(c.qty) || 1) });
  }
  return out;
}

const PLAN_FIELDS = ['name', 'description', 'membershipType', 'prefix', 'price', 'taxPercent', 'priceIncludesTax', 'validityMonths', 'benefits', 'branchIds', 'isActive', 'terms'];

/* ------------------------------ plans ------------------------------ */

exports.list = async (req, res) => {
  const q = {};
  if (req.query.includeInactive !== 'true') q.isActive = true;
  const rows = await Membership.find(q).sort({ isActive: -1, name: 1 }).lean();
  const counts = await MembershipAssignment.aggregate([{ $match: { status: 'Active' } }, { $group: { _id: '$membershipId', n: { $sum: 1 } } }]);
  const byId = new Map(counts.map((c) => [String(c._id), c.n]));
  return res.json({ success: true, data: rows.map((r) => ({ ...r, membersCount: byId.get(String(r._id)) || 0 })) });
};

exports.get = async (req, res) => {
  const m = await Membership.findById(req.params.id).lean();
  if (!m) return fail(res, 404, 'Membership not found');
  return res.json({ success: true, data: m });
};

exports.create = async (req, res) => {
  try {
    const b = req.body || {};
    if (!String(b.name || '').trim()) return fail(res, 400, 'Name is required');
    const code = String(b.code || b.name).trim().toUpperCase().replace(/[^A-Z0-9_-]+/g, '-').slice(0, 24);
    const m = new Membership({ code, seed: Math.max(1, Number(b.seed) || 1), credits: await cleanCredits(b.credits), discounts: { servicesPercent: Number(b.discounts?.servicesPercent) || 0, productsPercent: Number(b.discounts?.productsPercent) || 0, packagesPercent: Number(b.discounts?.packagesPercent) || 0 } });
    for (const k of PLAN_FIELDS) if (b[k] !== undefined) m[k] = b[k];
    if (b.isAppDefault) { await Membership.updateMany({ isAppDefault: true }, { $set: { isAppDefault: false } }); m.isAppDefault = true; }
    await m.save();
    return res.status(201).json({ success: true, data: m });
  } catch (e) {
    if (e.code === 11000) return fail(res, 409, 'A membership with that code already exists');
    return fail(res, 500, e.message);
  }
};

exports.update = async (req, res) => {
  try {
    const m = await Membership.findById(req.params.id);
    if (!m) return fail(res, 404, 'Membership not found');
    const b = req.body || {};
    for (const k of PLAN_FIELDS) if (b[k] !== undefined) m[k] = b[k];
    if (b.code !== undefined && String(b.code).trim()) m.code = String(b.code).trim().toUpperCase();
    if (b.seed !== undefined) m.seed = Math.max(1, Number(b.seed) || 1);
    if (b.credits !== undefined) m.credits = await cleanCredits(b.credits);
    if (b.discounts) m.discounts = { servicesPercent: Number(b.discounts.servicesPercent) || 0, productsPercent: Number(b.discounts.productsPercent) || 0, packagesPercent: Number(b.discounts.packagesPercent) || 0 };
    if (b.isAppDefault !== undefined) { if (b.isAppDefault) await Membership.updateMany({ _id: { $ne: m._id }, isAppDefault: true }, { $set: { isAppDefault: false } }); m.isAppDefault = !!b.isAppDefault; }
    await m.save();
    return res.json({ success: true, data: m });
  } catch (e) {
    if (e.code === 11000) return fail(res, 409, 'A membership with that code already exists');
    return fail(res, 500, e.message);
  }
};

exports.toggle = async (req, res) => {
  const m = await Membership.findById(req.params.id);
  if (!m) return fail(res, 404, 'Membership not found');
  m.isActive = !m.isActive; await m.save();
  return res.json({ success: true, data: m });
};

/* ------------------------------ members ------------------------------ */

exports.listMembers = async (req, res) => {
  const q = {};
  if (isId(req.query.userId)) q.userId = req.query.userId;
  if (isId(req.query.membershipId)) q.membershipId = req.query.membershipId;
  if (req.query.status && req.query.status !== 'all') q.status = req.query.status;
  if (req.query.search) { const rx = new RegExp(String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); q.$or = [{ memberNumber: rx }, { 'snapshot.name': rx }]; }
  const limit = Math.min(500, Number(req.query.limit) || 200);
  const rows = await MembershipAssignment.find(q).sort({ createdAt: -1 }).limit(limit).populate('userId', 'fullName phone email patientId guestCode').populate('membershipId', 'name code prefix').lean();
  if (req.query.search && !rows.length) {
    // fall back to a guest-name search
    const users = await User.find({ $or: [{ fullName: new RegExp(String(req.query.search), 'i') }, { phone: new RegExp(String(req.query.search).replace(/\D/g, '')) }] }).select('_id').limit(50).lean();
    if (users.length) { delete q.$or; q.userId = { $in: users.map((u) => u._id) }; const more = await MembershipAssignment.find(q).sort({ createdAt: -1 }).limit(limit).populate('userId', 'fullName phone email patientId guestCode').populate('membershipId', 'name code prefix').lean(); return res.json({ success: true, data: more }); }
  }
  return res.json({ success: true, data: rows });
};

/** Sell / grant a plan to a guest from the desk (no bill). The bill path is Invoice line kind 'membership'. */
exports.sell = async (req, res) => {
  try {
    const { userId, membershipId, branchId, startDate, paymentMethod, amount, paymentReceived, transactionId, notes, autoRenew } = req.body || {};
    const user = isId(userId) ? await User.findById(userId) : null;
    const plan = isId(membershipId) ? await Membership.findById(membershipId) : null;
    if (!user) return fail(res, 404, 'Guest not found');
    if (!plan || !plan.isActive) return fail(res, 404, 'Membership plan not found or inactive');
    const current = await currentMembership(user._id);
    const pa = await createMemberAssignment(plan, user, { branchId, startDate, paymentMethod, amount, paymentReceived, transactionId, notes, autoRenew, soldByName: who(req), extendFrom: current?.validUntil || null, source: 'panel' });
    return res.status(201).json({ success: true, data: pa, message: `${plan.name} ${current ? 'extended' : 'granted'} — member no. ${pa.memberNumber}` });
  } catch (e) {
    return fail(res, e.status || 500, e.message);
  }
};

/** Shared with the bill: create the assignment row, issue the number, sync the guest summary. */
async function createMemberAssignment(plan, user, { branchId = null, startDate = null, paymentMethod = null, amount = null, paymentReceived = true, transactionId = null, notes = '', autoRenew = false, soldByName = 'Admin', extendFrom = null, source = 'panel', invoiceId = null, amountPaid = null, balanceDue = null } = {}) {
  const start = extendFrom && new Date(extendFrom) > new Date() ? new Date(extendFrom) : (startDate ? new Date(startDate) : new Date());
  const until = new Date(start); until.setMonth(until.getMonth() + (Number(plan.validityMonths) || 12));
  const memberNumber = await Membership.nextMemberNumber(plan._id);
  const pa = await MembershipAssignment.create({
    userId: user._id, membershipId: plan._id, memberNumber,
    snapshot: { name: plan.name, code: plan.code, discounts: plan.discounts, validityMonths: plan.validityMonths, branchIds: (plan.branchIds || []).map(String) },
    credits: (plan.credits || []).map((c) => ({ serviceId: c.serviceId, serviceName: c.serviceName, qty: c.qty, used: 0 })),
    price: amount !== null && amount !== undefined && amount !== '' ? Number(amount) : plan.price,
    payment: { isReceived: !!paymentReceived, receivedDate: paymentReceived ? new Date() : null, paymentMethod: paymentMethod || null, transactionId: transactionId || null, amountPaid, balanceDue },
    invoiceId, branchId: isId(branchId) ? branchId : null, status: 'Active', validFrom: start, validUntil: until, autoRenew: !!autoRenew, notes: notes || '', source, soldByName,
  });
  await Membership.updateOne({ _id: plan._id }, { $inc: { membersCount: 1 } });
  await syncUserMembership(user._id);
  return pa;
}
exports.createMemberAssignment = createMemberAssignment;

exports.getMember = async (req, res) => {
  const pa = await MembershipAssignment.findById(req.params.id).populate('userId', 'fullName phone email patientId guestCode').populate('membershipId', 'name code prefix').lean();
  if (!pa) return fail(res, 404, 'Membership not found');
  return res.json({ success: true, data: pa });
};

exports.updateMember = async (req, res) => {
  try {
    const pa = await MembershipAssignment.findById(req.params.id);
    if (!pa) return fail(res, 404, 'Membership not found');
    const b = req.body || {};
    if (b.validUntil !== undefined) { pa.validUntil = b.validUntil ? new Date(b.validUntil) : null; if (pa.status === 'Expired' && pa.validUntil && pa.validUntil > new Date()) pa.status = 'Active'; }
    if (b.notes !== undefined) pa.notes = String(b.notes || '');
    if (b.autoRenew !== undefined) pa.autoRenew = !!b.autoRenew;
    if (b.payment) { for (const k of ['isReceived', 'paymentMethod', 'transactionId', 'amountPaid', 'balanceDue']) if (b.payment[k] !== undefined) pa.payment[k] = b.payment[k]; if (b.payment.isReceived && !pa.payment.receivedDate) pa.payment.receivedDate = new Date(); }
    await pa.save();
    await syncUserMembership(pa.userId);
    return res.json({ success: true, data: pa });
  } catch (e) { return fail(res, 500, e.message); }
};

exports.cancelMember = async (req, res) => {
  try {
    const pa = await MembershipAssignment.findById(req.params.id);
    if (!pa) return fail(res, 404, 'Membership not found');
    if (pa.status === 'Cancelled') return fail(res, 409, 'Already cancelled');
    const { reason, refundAmount, refundMethod } = req.body || {};
    if (!String(reason || '').trim()) return fail(res, 400, 'Give a reason');
    pa.status = 'Cancelled';
    pa.cancellation = { cancelledAt: new Date(), byName: who(req), reason, refundAmount: Number(refundAmount) || 0, refundMethod: refundMethod || null };
    await pa.save();
    await syncUserMembership(pa.userId);
    return res.json({ success: true, data: pa, message: 'Membership cancelled' });
  } catch (e) { return fail(res, 500, e.message); }
};

/** GET /api/memberships/me — the signed-in guest's own membership (app). */
exports.me = async (req, res) => {
  const m = await currentMembership(req.user._id);
  if (!m) return res.json({ success: true, data: null });
  const plan = m.assignment ? await Membership.findById(m.assignment.membershipId).select('name benefits terms').lean() : null;
  return res.json({ success: true, data: { kind: m.kind, name: m.name, memberNumber: m.memberNumber, validUntil: m.validUntil, discounts: m.discounts, credits: m.credits, benefits: plan?.benefits || [], terms: plan?.terms || '', validFrom: m.assignment?.validFrom || null, redemptions: (m.assignment?.redemptions || []).filter((r) => !r.reversed).slice(-20).reverse() } });
};

/** The guest's current membership as the bill and the profile see it. */
exports.currentForUser = async (req, res) => {
  if (!isId(req.params.userId)) return fail(res, 400, 'userId required');
  const m = await currentMembership(req.params.userId);
  return res.json({ success: true, data: m ? { kind: m.kind, name: m.name, memberNumber: m.memberNumber, validUntil: m.validUntil, discounts: m.discounts, credits: m.credits, assignmentId: m.assignment?._id || null } : null });
};
