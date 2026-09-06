const MessageTemplate = require('../models/MessageTemplate');
const { templateVars } = require('../utils/guestMessaging');

const fail = (res, s, m) => res.status(s).json({ success: false, message: m });
const who = (req) => req.admin?.name || req.admin?.email || 'Admin';
const FIELDS = ['name', 'channel', 'category', 'subject', 'body', 'twilioContentSid', 'contentVariables', 'isActive', 'branchIds'];

exports.list = async (req, res) => {
  const q = {};
  if (req.query.channel && req.query.channel !== 'all') q.channel = req.query.channel;
  if (req.query.category && req.query.category !== 'all') q.category = req.query.category;
  if (req.query.includeInactive !== 'true') q.isActive = true;
  const rows = await MessageTemplate.find(q).sort({ category: 1, name: 1 }).lean();
  return res.json({ success: true, data: rows, placeholders: MessageTemplate.PLACEHOLDERS });
};

exports.create = async (req, res) => {
  try {
    const b = req.body || {};
    if (!String(b.name || '').trim() || !String(b.body || '').trim()) return fail(res, 400, 'Name and body are required');
    const key = String(b.key || b.name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
    const doc = new MessageTemplate({ key, createdByName: who(req) });
    for (const k of FIELDS) if (b[k] !== undefined) doc[k] = b[k];
    await doc.save();
    return res.status(201).json({ success: true, data: doc });
  } catch (e) { return fail(res, e.code === 11000 ? 409 : 500, e.code === 11000 ? 'A template with that key exists' : e.message); }
};

exports.update = async (req, res) => {
  try {
    const doc = await MessageTemplate.findById(req.params.id);
    if (!doc) return fail(res, 404, 'Template not found');
    const b = req.body || {};
    for (const k of FIELDS) if (b[k] !== undefined) doc[k] = b[k];
    doc.updatedByName = who(req);
    await doc.save();
    return res.json({ success: true, data: doc });
  } catch (e) { return fail(res, 500, e.message); }
};

exports.remove = async (req, res) => {
  const doc = await MessageTemplate.findByIdAndDelete(req.params.id);
  if (!doc) return fail(res, 404, 'Template not found');
  return res.json({ success: true, message: 'Template deleted' });
};

/** POST /:id/preview { userId?, bookingId?, invoiceId? } → rendered body with real values. */
exports.preview = async (req, res) => {
  try {
    const doc = await MessageTemplate.findById(req.params.id).lean();
    if (!doc) return fail(res, 404, 'Template not found');
    const vars = await varsFrom(req.body || {}, who(req));
    return res.json({ success: true, data: { body: MessageTemplate.render(doc.body, vars), subject: MessageTemplate.render(doc.subject || '', vars), vars } });
  } catch (e) { return fail(res, 500, e.message); }
};

async function varsFrom({ userId, bookingId, invoiceId, assignmentId }, staffName) {
  const User = require('../models/User'); const Booking = require('../models/Booking'); const Invoice = require('../models/Invoice'); const PackageAssignment = require('../models/PackageAssignment');
  const [user, booking, invoice, assignment] = await Promise.all([
    userId ? User.findById(userId).lean() : null,
    bookingId ? Booking.findById(bookingId).populate('consultationId', 'name') : null,
    invoiceId ? Invoice.findById(invoiceId).lean() : null,
    assignmentId ? PackageAssignment.findById(assignmentId) : null,
  ]);
  const u = user || (booking?.userId ? await User.findById(booking.userId).lean() : null) || (invoice?.userId ? await User.findById(invoice.userId).lean() : null);
  const { currentMembership } = require('../utils/membershipRules');
  const membership = u ? await currentMembership(u._id).catch(() => null) : null;
  return templateVars({ user: u, booking, invoice, assignment, membership, staffName });
}
exports.varsFrom = varsFrom;
