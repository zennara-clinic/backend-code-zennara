/**
 * Membership plans (Zenoti "Manage memberships") and the guests who hold them.
 */
const mongoose = require('mongoose');
const Membership = require('../models/Membership');
const MembershipAssignment = require('../models/MembershipAssignment');
const User = require('../models/User');
const Consultation = require('../models/Consultation');
const { syncUserMembership, currentMembership } = require('../utils/membershipRules');
const { resolveZenPricing, pricingSummary, zenPlanRow } = require('../utils/zenMembership');
const { isZenMembership, isActiveMembershipStatus, clinicCenterIdForBranch } = require('../config/zenoti');

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

/*
 * The clinic sells ONE membership. By default the list is exactly that plan;
 * the retired Zenoti variants (MVP, MVP-2026 …) and anything else ever created
 * come back only with includeInactive=true. The Zen row carries `live` — the
 * price the app charges right now (utils/zenMembership) — beside the stored
 * one, so the panel can see when the two disagree instead of finding out from
 * a guest's receipt.
 */
exports.list = async (req, res) => {
  const all = req.query.includeInactive === 'true';
  const plan = await zenPlanRow().catch(() => null);
  let rows;
  if (all) rows = await Membership.find({}).sort({ isActive: -1, name: 1 }).lean();
  else rows = plan ? [plan.toObject ? plan.toObject() : plan] : await Membership.find({ isActive: true }).sort({ name: 1 }).lean();
  const counts = await MembershipAssignment.aggregate([{ $match: { status: 'Active' } }, { $group: { _id: '$membershipId', n: { $sum: 1 } } }]);
  const byId = new Map(counts.map((c) => [String(c._id), c.n]));
  const live = pricingSummary(await resolveZenPricing().catch(() => null));
  const zenId = plan ? String(plan._id) : null;
  return res.json({ success: true, data: rows.map((r) => ({ ...r, membersCount: byId.get(String(r._id)) || 0, ...(zenId && String(r._id) === zenId ? { live } : {}) })) });
};

/**
 * GET /api/memberships/zen — the Zen membership as the app's card shows it:
 * one price (from Zenoti when it can be read, App Studio otherwise), copy,
 * benefits and terms from App Studio. The same figure Razorpay charges.
 */
exports.zen = async (_req, res) => {
  const p = await resolveZenPricing();
  return res.json({ success: true, data: {
    name: p.name || 'Zen Membership',
    tagline: p.tagline,
    description: p.description,
    price: {
      amount: p.amount, currency: p.currency, source: p.source,
      zenotiListPrice: p.zenotiListPrice, zenotiName: p.zenotiName,
      basePriceInr: p.basePriceInr, salePriceInr: p.salePriceInr, renewalPriceInr: p.renewalPriceInr,
      taxPercent: p.taxPercent,
    },
    validityMonths: p.validityMonths,
    discountPercent: p.discountPercent,
    benefits: p.benefits,
    terms: p.terms,
    isActive: p.isActive,
    image: p.image,
    ctaText: p.ctaText,
  } });
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
  /*
   * Every sale made HERE — in the app, at the desk, or as a bill line — is
   * pushed into Zenoti as a membership sale, so the clinic's own register and
   * ours agree. Fire-and-forget: the write service is mode-gated and never
   * throws, and a Zenoti hiccup must not fail a sale the guest has paid for.
   * A row mirrored FROM Zenoti is never pushed back (it would sell it twice).
   */
  if (source !== 'zenoti') {
    setImmediate(() => {
      try {
        require('../services/zenotiWriteService').syncMembership(user._id, { assignmentId: pa._id }).catch(() => {});
      } catch (_) { /* best-effort */ }
    });
  }
  return pa;
}
exports.createMemberAssignment = createMemberAssignment;

/** POST /api/memberships/members/:id/zenoti-push — (re)run the Zenoti sale for one row. */
exports.zenotiPush = async (req, res) => {
  try {
    const pa = await MembershipAssignment.findById(req.params.id);
    if (!pa) return fail(res, 404, 'Membership not found');
    if (pa.source === 'zenoti') return fail(res, 409, 'This membership was sold in Zenoti — there is nothing to push.');
    const sync = await require('../services/zenotiWriteService').syncMembership(pa.userId, { assignmentId: pa._id });
    const fresh = await MembershipAssignment.findById(pa._id).populate('userId', 'fullName phone email patientId guestCode').populate('membershipId', 'name code prefix').lean();
    return res.json({ success: sync.status !== 'failed', data: fresh, sync, message: sync.error || (sync.status === 'synced' ? 'Sold in Zenoti' : sync.status) });
  } catch (e) { return fail(res, 500, e.message); }
};

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

/**
 * The guest's Zen membership as Zenoti holds it right now — credits, expiry,
 * guest passes — mapped for the member screen. Zenoti computes the balances
 * when the desk redeems, so a live read is the only copy that is never stale.
 */
function liveMembershipView(rows, at = new Date()) {
  const zen = (Array.isArray(rows) ? rows : []).filter((m) => m && (isZenMembership(m.name) || isZenMembership(m.code)));
  if (!zen.length) return null;
  const expired = (m) => m.expiryDate && !Number.isNaN(Date.parse(m.expiryDate)) && Date.parse(m.expiryDate) <= at.getTime();
  const usable = zen.find((m) => m.redeemable === true) || zen.find((m) => !m.isRefunded && !expired(m) && isActiveMembershipStatus(m.status));
  const pick = usable || [...zen].sort((a, b) => (Date.parse(b.expiryDate || '') || 0) - (Date.parse(a.expiryDate || '') || 0))[0];
  const line = (x) => ({ name: x.name, total: x.total, used: x.used, balance: x.balance, expiryDate: x.expiryDate || null });
  return {
    status: pick.isRefunded ? 'Cancelled' : expired(pick) ? 'Expired' : isActiveMembershipStatus(pick.status) ? 'Active' : 'Expired',
    redeemable: pick.redeemable ?? null,
    memberSince: pick.memberSince || null,
    expiryDate: pick.expiryDate || null,
    invoiceNumber: pick.invoice?.number || null,
    creditBalance: pick.creditBalance ?? null,
    creditAmount: pick.creditAmount ?? null,
    services: (pick.services || []).filter((x) => x?.name).map(line),
    products: (pick.products || []).filter((x) => x?.name).map(line),
    guestPassTotal: pick.guestPassTotal ?? null,
    guestPassBalance: pick.guestPassBalance ?? null,
    htmlBenefits: pick.htmlBenefits || null,
    terms: pick.terms || null,
    centerName: pick.centerName || null,
    liveAt: at.toISOString(),
  };
}
exports.liveMembershipView = liveMembershipView;

/** A live Zenoti read for one screen must not hang the app behind the rate-limit queue. */
const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('Zenoti read timed out')), ms).unref?.())]);

/** GET /api/memberships/me — the signed-in guest's own membership (app). */
exports.me = async (req, res) => {
  const m = await currentMembership(req.user._id);
  if (!m) return res.json({ success: true, data: null });
  const a = m.assignment;
  const plan = a ? await Membership.findById(a.membershipId).select('name benefits terms').lean() : null;
  const pricing = await resolveZenPricing().catch(() => null);

  // The live copy from Zenoti, when this guest is a Zenoti guest. Our row is
  // returned whatever happens here; `liveUnavailable` says the read failed.
  let zenoti = null;
  let liveUnavailable = false;
  const guest = await User.findById(req.user._id).select('zenotiGuestId zenotiCenterId location').lean().catch(() => null);
  if (guest?.zenotiGuestId) {
    try {
      const z = require('../services/zenotiService');
      if (!z.isConfigured()) throw new Error('Zenoti is not configured');
      const rows = await withTimeout(z.getGuestMemberships(guest.zenotiGuestId, guest.zenotiCenterId || clinicCenterIdForBranch(guest.location)), 8000);
      zenoti = liveMembershipView(rows);
    } catch (_) { liveUnavailable = true; }
  }

  return res.json({ success: true, data: {
    kind: m.kind, name: m.name, memberNumber: m.memberNumber, validUntil: m.validUntil, discounts: m.discounts, credits: m.credits,
    benefits: plan?.benefits || [], terms: plan?.terms || '', validFrom: a?.validFrom || null,
    redemptions: (a?.redemptions || []).filter((r) => !r.reversed).slice(-20).reverse(),
    status: a?.status || (m.kind === 'legacy' ? 'Active' : null),
    source: a?.source || (m.kind === 'legacy' ? 'legacy' : null),
    zenotiSync: a && (a.zenotiSyncStatus || a.zenotiInvoiceId) ? { status: a.zenotiSyncStatus || null, invoiceId: a.zenotiInvoiceId || null, invoiceNumber: a.zenotiInvoiceNumber || null, error: a.zenotiSyncError || null } : null,
    zenoti,
    liveUnavailable,
    pricing: pricing ? { amount: pricing.amount, currency: pricing.currency, source: pricing.source, renewalPriceInr: pricing.renewalPriceInr, validityMonths: pricing.validityMonths } : null,
  } });
};

/** The guest's current membership as the bill and the profile see it. */
exports.currentForUser = async (req, res) => {
  if (!isId(req.params.userId)) return fail(res, 400, 'userId required');
  const m = await currentMembership(req.params.userId);
  return res.json({ success: true, data: m ? { kind: m.kind, name: m.name, memberNumber: m.memberNumber, validUntil: m.validUntil, discounts: m.discounts, credits: m.credits, assignmentId: m.assignment?._id || null } : null });
};
