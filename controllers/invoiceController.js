/**
 * Desk billing — Zenoti's POS, for our data.
 *
 * Flow (same as the front desk is used to): "Take payment" on a visit opens
 * its bill (created on first open, one per visit group); the desk adds or
 * removes lines (services, products, a package, a custom charge), applies a
 * discount or the guest's package benefits, takes one or more tenders, and the
 * bill closes on its own when the due reaches zero (or explicitly, with a
 * balance, when a manager allows). Closing is when the side effects happen:
 * visit rows become paid, pharmacy stock leaves the shelf, package sessions
 * are consumed, a sold package becomes a PackageAssignment. Void reverses all
 * of that and keeps the number.
 *
 * Nothing here talks to Zenoti.
 */
const mongoose = require('mongoose');
const Invoice = require('../models/Invoice');
const Booking = require('../models/Booking');
const User = require('../models/User');
const Branch = require('../models/Branch');
const Consultation = require('../models/Consultation');
const Product = require('../models/Product');
const Inventory = require('../models/Inventory');
const Package = require('../models/Package');
const PackageAssignment = require('../models/PackageAssignment');
const StockMovement = require('../models/StockMovement');
const Doctor = require('../models/Doctor');
const { issueInvoiceNumber, issueReceiptNumber } = require('../utils/invoiceNumbers');
const { renderReceiptHtml, receiptText } = require('../utils/invoiceReceipt');
const { clinicDayStart, clinicDayEnd } = require('../utils/bookingTime');
const Membership = require('../models/Membership');
const MembershipAssignment = require('../models/MembershipAssignment');
const packageRules = require('../utils/packageRules');
const { currentMembership, discountPercentFor, syncUserMembership } = require('../utils/membershipRules');

/** GST on a service when the master carries none — Zennara bills services at 5%. */
const DEFAULT_SERVICE_TAX = 5;
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ''));
const who = (req) => ({ id: req.admin?._id || null, name: req.admin?.name || req.admin?.email || 'desk' });
const fail = (res, status, message, extra = {}) => res.status(status).json({ success: false, message, ...extra });

const sellerFrom = (b) => ({
  name: b?.name || null, legalName: b?.legalName || null, gstin: b?.gstin || null, pan: b?.pan || null, stateCode: b?.stateCode || null,
  address: [b?.address?.line1, b?.address?.line2, b?.address?.city, b?.address?.pincode].filter(Boolean).join(', ') || null,
  phone: Array.isArray(b?.contact?.phone) ? b.contact.phone[0] || null : b?.contact?.phone || null,
  email: b?.contact?.email || null,
});
const guestFrom = (u, fallback = {}) => ({
  name: u?.fullName || fallback.name || null, phone: u?.phone || fallback.phone || null,
  email: u?.email && !/@zennara\.local$|@guest\.zennara\.in$/i.test(u.email) ? u.email : null,
  patientId: u?.patientId || null, gender: u?.gender || null, stateCode: null, gstin: null,
});

async function resolveBranch({ branchId, booking }) {
  if (isId(branchId)) return Branch.findById(branchId);
  if (booking?.branchId) return Branch.findById(booking.branchId);
  if (booking?.preferredLocation) return Branch.findOne({ name: new RegExp(`^${booking.preferredLocation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
  return null;
}

/** Build the service line a visit row bills for. */
async function lineFromBooking(bk, branch) {
  const c = bk.consultationId && typeof bk.consultationId === 'object' ? bk.consultationId : (isId(bk.consultationId) ? await Consultation.findById(bk.consultationId) : null);
  const priced = c && typeof c.priceAt === 'function' ? c.priceAt(branch?._id) : null;
  const redeemed = !!(bk.packageAssignmentId || bk.isPackageIncluded);
  // The booked amount is what the guest agreed to (may already carry a member
  // discount); the master price is the fallback and the list value when redeemed.
  const listPrice = priced ? priced.price : Number(bk.amount) || 0;
  const unitPrice = redeemed ? listPrice : (Number(bk.amount) > 0 ? Number(bk.amount) : listPrice);
  let soldByName = bk.specialistName || null; let soldById = bk.specialistId || null;
  return {
    kind: 'service', refId: c?._id || null, refModel: c ? 'Consultation' : null, bookingId: bk._id,
    name: c?.name || bk.externalServiceName || 'Service', code: c?.code || null, hsn: c?.sac || null,
    qty: 1, unitPrice, priceIncludesTax: priced ? priced.priceIncludesTax !== false : true,
    taxPercent: priced ? priced.taxPercent : DEFAULT_SERVICE_TAX,
    discount: 0, discountPercent: 0,
    redeemed: redeemed ? { kind: 'package', packageAssignmentId: bk.packageAssignmentId || null, sessionId: bk.packageSessionId || null, label: 'Package session' } : { kind: null },
    soldById, soldByName, soldByModel: soldById ? 'Doctor' : null,
  };
}

/** Build a line from what the desk picked in the add-line tabs. */
async function buildLine(body, branch) {
  const qty = Math.max(0, Number(body.qty ?? 1) || 0);
  const soldBy = { soldById: body.soldById || null, soldByName: body.soldByName || null, soldByModel: body.soldByModel || (body.soldById ? 'Doctor' : null) };
  const disc = { discount: Math.max(0, Number(body.discount) || 0), discountPercent: Math.min(100, Math.max(0, Number(body.discountPercent) || 0)) };
  if (body.consultationId) {
    const c = await Consultation.findById(body.consultationId);
    if (!c) throw Object.assign(new Error('Service not found'), { status: 404 });
    const p = c.priceAt(branch?._id);
    return { kind: 'service', refId: c._id, refModel: 'Consultation', bookingId: isId(body.bookingId) ? body.bookingId : null, name: c.name, code: c.code || null, hsn: c.sac || null, qty: qty || 1,
      unitPrice: body.unitPrice !== undefined && body.unitPrice !== '' ? Number(body.unitPrice) : p.price, priceIncludesTax: body.priceIncludesTax ?? p.priceIncludesTax, taxPercent: body.taxPercent ?? p.taxPercent, ...disc, ...soldBy, notes: body.notes || '' };
  }
  if (body.inventoryId) {
    const inv = await Inventory.findById(body.inventoryId);
    if (!inv) throw Object.assign(new Error('Stock item not found'), { status: 404 });
    const inclusive = inv.inventoryAfterTaxSellingPrice > 0;
    const unit = body.unitPrice !== undefined && body.unitPrice !== '' ? Number(body.unitPrice) : (inclusive ? inv.inventoryAfterTaxSellingPrice : inv.inventorySellingPrice || inv.batchSellingPrice || 0);
    return { kind: 'product', refId: inv._id, refModel: 'Inventory', inventoryId: inv._id, name: inv.inventoryName, code: inv.code || null, hsn: body.hsn || null, qty: qty || 1,
      unitPrice: unit, priceIncludesTax: body.priceIncludesTax ?? inclusive, taxPercent: body.taxPercent ?? (inv.gstPercentage || 0), batchNo: inv.batchNo || null, expiryDate: inv.batchExpiryDate || null, ...disc, ...soldBy, notes: body.notes || '' };
  }
  if (body.productId) {
    const p = await Product.findById(body.productId);
    if (!p) throw Object.assign(new Error('Product not found'), { status: 404 });
    // Store prices are tax-exclusive (utils/orderPricing adds GST on top); the
    // MRP, when Zenoti gave us one, already includes tax.
    const useMrp = body.useMrp && Number(p.mrp) > 0;
    return { kind: 'product', refId: p._id, refModel: 'Product', name: p.name, code: p.sku || p.code || null, hsn: p.hsn || null, qty: qty || 1,
      unitPrice: body.unitPrice !== undefined && body.unitPrice !== '' ? Number(body.unitPrice) : (useMrp ? p.mrp : p.price), priceIncludesTax: body.priceIncludesTax ?? !!useMrp, taxPercent: body.taxPercent ?? (p.gstPercentage || 0),
      batchNo: body.batchNo || null, expiryDate: body.expiryDate || null, ...disc, ...soldBy, notes: [p.isRx ? 'Rx' : '', body.notes || ''].filter(Boolean).join(' · ') };
  }
  if (body.packageId) {
    const pk = await Package.findById(body.packageId);
    if (!pk) throw Object.assign(new Error('Package not found'), { status: 404 });
    return { kind: 'package', refId: pk._id, refModel: 'Package', name: pk.name, code: pk.id || null, qty: 1,
      unitPrice: body.unitPrice !== undefined && body.unitPrice !== '' ? Number(body.unitPrice) : pk.price, priceIncludesTax: body.priceIncludesTax ?? pk.priceIncludesTax !== false, taxPercent: body.taxPercent ?? (pk.taxPercent ?? 5), ...disc, ...soldBy, notes: body.notes || '' };
  }
  if (body.membershipId) {
    const mp = await Membership.findById(body.membershipId);
    if (!mp || !mp.isActive) throw Object.assign(new Error('Membership plan not found or inactive'), { status: 404 });
    const p = mp.priceAt();
    return { kind: 'membership', refId: mp._id, refModel: 'Membership', name: mp.name, code: mp.code || null, qty: 1,
      unitPrice: body.unitPrice !== undefined && body.unitPrice !== '' ? Number(body.unitPrice) : p.price, priceIncludesTax: body.priceIncludesTax ?? p.priceIncludesTax, taxPercent: body.taxPercent ?? p.taxPercent, ...disc, ...soldBy, notes: body.notes || '' };
  }
  if (body.kind === 'custom' || body.name) {
    if (!String(body.name || '').trim()) throw Object.assign(new Error('A name is required for a custom line'), { status: 400 });
    return { kind: 'custom', name: String(body.name).trim(), qty: qty || 1, unitPrice: Math.max(0, Number(body.unitPrice) || 0), priceIncludesTax: body.priceIncludesTax ?? true, taxPercent: Math.max(0, Number(body.taxPercent) || 0), hsn: body.hsn || null, ...disc, ...soldBy, notes: body.notes || '' };
  }
  throw Object.assign(new Error('Pick a service, product, package or enter a custom line'), { status: 400 });
}

/**
 * Member tiers: a guest with a live membership gets its % off every service /
 * product / package line the moment the line lands on the bill (Zenoti applies
 * the membership discount on its own). The desk can still override a line.
 */
async function applyMembershipDiscounts(inv) {
  if (!inv.userId) return;
  const m = await currentMembership(inv.userId);
  if (!m) { inv.membership = { kind: null, name: null, memberNumber: null, assignmentId: null }; for (const l of inv.lines) if (l.discountSource === 'membership') { l.discountPercent = 0; l.discount = 0; l.discountSource = null; l.discountLabel = null; } return; }
  inv.membership = { kind: m.kind, name: m.name, memberNumber: m.memberNumber || null, assignmentId: m.assignment?._id || null };
  for (const l of inv.lines) {
    if (l.redeemed?.kind || l.kind === 'membership' || l.kind === 'custom') continue;
    if (l.discountSource === 'manual') continue;
    const pct = discountPercentFor(m, l.kind);
    if (pct > 0) { l.discountPercent = pct; l.discountSource = 'membership'; l.discountLabel = `${m.name}${m.memberNumber ? ` ${m.memberNumber}` : ''} · ${pct}% off`; }
    else if (l.discountSource === 'membership') { l.discountPercent = 0; l.discount = 0; l.discountSource = null; l.discountLabel = null; }
  }
}

const populateInvoice = (q) => q.populate('userId', 'fullName phone email patientId gender memberType zenMembershipExpiryDate').populate('branchId', 'name invoicePrefix');
const loadInvoice = (id) => populateInvoice(Invoice.findById(id));
const send = (res, inv, status = 200, extra = {}) => res.status(status).json({ success: true, data: inv, ...extra });
const mustBeOpen = (inv, res) => (inv.status !== 'open' ? (fail(res, 409, `This invoice is ${inv.status}. Reopen it to make changes.`, { code: 'INVOICE_NOT_OPEN' }), false) : true);

/* ------------------------------------------------------------------------ */
/* Create / read                                                             */
/* ------------------------------------------------------------------------ */

// POST /api/invoices — open (or return) the bill for a visit / a guest.
exports.create = async (req, res) => {
  try {
    const { bookingId, bookingIds, visitGroupId, userId, branchId, lines = [] } = req.body || {};
    let bookings = [];
    if (visitGroupId) bookings = await Booking.find({ visitGroupId, status: { $nin: ['Cancelled'] } }).populate('consultationId');
    else if (Array.isArray(bookingIds) && bookingIds.length) bookings = await Booking.find({ _id: { $in: bookingIds.filter(isId) } }).populate('consultationId');
    else if (isId(bookingId)) {
      const b = await Booking.findById(bookingId).populate('consultationId');
      if (!b) return fail(res, 404, 'Booking not found');
      bookings = b.visitGroupId ? await Booking.find({ visitGroupId: b.visitGroupId, status: { $nin: ['Cancelled'] } }).populate('consultationId') : [b];
      if (!bookings.some((x) => String(x._id) === String(b._id))) bookings.push(b);
    }
    // One live bill per visit: "Take payment" twice opens the same invoice.
    const linked = bookings.find((b) => b.invoiceId);
    if (linked) {
      const existing = await loadInvoice(linked.invoiceId);
      if (existing && existing.status !== 'void') return send(res, existing, 200, { existing: true });
    }
    const first = bookings[0] || null;
    const user = isId(userId) ? await User.findById(userId) : first?.userId ? await User.findById(first.userId) : null;
    const branch = await resolveBranch({ branchId, booking: first });
    if (!branch) return fail(res, 400, 'Pick the centre this bill is raised at.');
    if (!user && !first) return fail(res, 400, 'A guest or a booking is required.');

    const me = who(req);
    const now = new Date();
    const inv = new Invoice({
      invoiceNumber: await issueInvoiceNumber(branch, now),
      branchId: branch._id, seller: sellerFrom(branch),
      userId: user?._id || first?.userId || null,
      guest: guestFrom(user, { name: first?.fullName, phone: first?.mobileNumber }),
      visitGroupId: first?.visitGroupId || null,
      source: 'desk', issuedAt: now, createdById: me.id, createdByName: me.name,
      bookingIds: bookings.map((b) => b._id),
    });
    for (const b of bookings) inv.lines.push(await lineFromBooking(b, branch));
    for (const raw of lines) inv.lines.push(await buildLine(raw, branch));
    await applyMembershipDiscounts(inv);
    await inv.save();
    if (bookings.length) await Booking.updateMany({ _id: { $in: bookings.map((b) => b._id) } }, { $set: { invoiceId: inv._id } });
    return send(res, await loadInvoice(inv._id), 201);
  } catch (e) {
    console.error('Invoice create error:', e);
    return fail(res, e.status || 500, e.message || 'Could not open the invoice');
  }
};

// GET /api/invoices — register (a day, a range, a guest, a number).
exports.list = async (req, res) => {
  try {
    const { date, from, to, branchId, status, search, userId, bookingId } = req.query;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const q = {};
    if (isId(branchId)) q.branchId = branchId;
    if (status && status !== 'all') q.status = status;
    if (isId(userId)) q.userId = userId;
    if (isId(bookingId)) q.bookingIds = bookingId;
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) q.issuedAt = { $gte: clinicDayStart(date), $lte: clinicDayEnd(date) };
    else if (from || to) { q.issuedAt = {}; if (from) q.issuedAt.$gte = clinicDayStart(from); if (to) q.issuedAt.$lte = clinicDayEnd(to); }
    if (search && String(search).trim()) {
      const s = String(search).trim();
      const rx = new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      q.$or = [{ invoiceNumber: rx }, { receiptNumber: rx }, { 'guest.name': rx }, { 'guest.phone': rx }, { 'guest.patientId': rx }, { 'lines.name': rx }];
    }
    const [rows, total, agg] = await Promise.all([
      populateInvoice(Invoice.find(q).sort({ issuedAt: -1 }).skip((page - 1) * limit).limit(limit)).lean(),
      Invoice.countDocuments(q),
      Invoice.aggregate([{ $match: { ...q, ...(q.branchId ? { branchId: new mongoose.Types.ObjectId(q.branchId) } : {}), ...(q.userId ? { userId: new mongoose.Types.ObjectId(q.userId) } : {}), ...(q.bookingIds ? { bookingIds: new mongoose.Types.ObjectId(q.bookingIds) } : {}) } }, { $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$totals.total' }, paid: { $sum: '$totals.paid' }, due: { $sum: '$totals.due' } } }]),
    ]);
    const totals = { count: total, amount: 0, paid: 0, due: 0, byStatus: {} };
    for (const a of agg) { totals.byStatus[a._id] = { count: a.count, amount: a.amount, paid: a.paid, due: a.due }; if (a._id !== 'void') { totals.amount += a.amount; totals.paid += a.paid; totals.due += a.due; } }
    return res.json({ success: true, data: rows, totals, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (e) {
    console.error('Invoice list error:', e);
    return fail(res, 500, 'Could not load invoices');
  }
};

// GET /api/invoices/lookup?number=ZNJH260012 — invoice or receipt number.
exports.lookup = async (req, res) => {
  const n = String(req.query.number || '').trim().toUpperCase();
  if (!n) return fail(res, 400, 'number is required');
  const inv = await populateInvoice(Invoice.findOne({ $or: [{ invoiceNumber: n }, { receiptNumber: n }] }));
  if (!inv) return fail(res, 404, `No invoice or receipt numbered ${n}`);
  return send(res, inv);
};

exports.get = async (req, res) => {
  const inv = await loadInvoice(req.params.id);
  if (!inv) return fail(res, 404, 'Invoice not found');
  return send(res, inv);
};

/** Payment methods the desk can pick (the panel reads this, so both stay in step). */
exports.meta = async (req, res) => res.json({ success: true, data: { methods: Invoice.METHODS, lineKinds: Invoice.LINE_KINDS } });

/* ------------------------------------------------------------------------ */
/* Lines, discount, comments                                                 */
/* ------------------------------------------------------------------------ */

exports.addLine = async (req, res) => {
  try {
    const inv = await Invoice.findById(req.params.id);
    if (!inv) return fail(res, 404, 'Invoice not found');
    if (!mustBeOpen(inv, res)) return;
    const branch = await Branch.findById(inv.branchId);
    const line = await buildLine(req.body || {}, branch);
    if (line.bookingId) {
      const b = await Booking.findById(line.bookingId).select('invoiceId userId');
      if (b?.invoiceId && String(b.invoiceId) !== String(inv._id)) return fail(res, 409, 'That visit is already on another invoice.');
      if (inv.lines.some((l) => String(l.bookingId) === String(line.bookingId))) return fail(res, 409, 'That visit is already on this invoice.');
    }
    inv.lines.push(line);
    await applyMembershipDiscounts(inv);
    await inv.save();
    if (line.bookingId) { await Booking.updateOne({ _id: line.bookingId }, { $set: { invoiceId: inv._id } }); if (!inv.bookingIds.some((x) => String(x) === String(line.bookingId))) { inv.bookingIds.push(line.bookingId); await inv.save(); } }
    return send(res, await loadInvoice(inv._id));
  } catch (e) {
    return fail(res, e.status || 500, e.message || 'Could not add the line');
  }
};

exports.updateLine = async (req, res) => {
  try {
    const inv = await Invoice.findById(req.params.id);
    if (!inv) return fail(res, 404, 'Invoice not found');
    if (!mustBeOpen(inv, res)) return;
    const line = inv.lines.id(req.params.lineId);
    if (!line) return fail(res, 404, 'Line not found');
    const b = req.body || {};
    if (b.qty !== undefined) line.qty = Math.max(0, Number(b.qty) || 0);
    if (b.unitPrice !== undefined) line.unitPrice = Math.max(0, Number(b.unitPrice) || 0);
    if (b.taxPercent !== undefined) line.taxPercent = Math.max(0, Number(b.taxPercent) || 0);
    if (b.priceIncludesTax !== undefined) line.priceIncludesTax = !!b.priceIncludesTax;
    if (b.discountPercent !== undefined) { line.discountPercent = Math.min(100, Math.max(0, Number(b.discountPercent) || 0)); if (line.discountPercent === 0 && b.discount === undefined) line.discount = 0; line.discountSource = 'manual'; line.discountLabel = null; }
    if (b.discount !== undefined) { line.discount = Math.max(0, Number(b.discount) || 0); if (b.discountPercent === undefined) line.discountPercent = 0; line.discountSource = 'manual'; line.discountLabel = null; }
    if (b.restoreMembershipDiscount) { line.discountSource = null; line.discount = 0; line.discountPercent = 0; await applyMembershipDiscounts(inv); }
    if (b.soldById !== undefined || b.soldByName !== undefined) { line.soldById = b.soldById || null; line.soldByName = b.soldByName || null; line.soldByModel = b.soldByModel || (b.soldById ? 'Doctor' : null); }
    if (b.notes !== undefined) line.notes = String(b.notes || '');
    if (b.hsn !== undefined) line.hsn = b.hsn || null;
    if (b.batchNo !== undefined) line.batchNo = b.batchNo || null;
    if (b.expiryDate !== undefined) line.expiryDate = b.expiryDate ? new Date(b.expiryDate) : null;
    await inv.save();
    return send(res, await loadInvoice(inv._id));
  } catch (e) {
    return fail(res, 500, e.message || 'Could not update the line');
  }
};

exports.removeLine = async (req, res) => {
  try {
    const inv = await Invoice.findById(req.params.id);
    if (!inv) return fail(res, 404, 'Invoice not found');
    if (!mustBeOpen(inv, res)) return;
    const line = inv.lines.id(req.params.lineId);
    if (!line) return fail(res, 404, 'Line not found');
    const bookingId = line.bookingId;
    line.deleteOne();
    if (bookingId) inv.bookingIds = inv.bookingIds.filter((x) => String(x) !== String(bookingId));
    await inv.save();
    if (bookingId) await Booking.updateOne({ _id: bookingId, invoiceId: inv._id }, { $set: { invoiceId: null } });
    return send(res, await loadInvoice(inv._id));
  } catch (e) {
    return fail(res, 500, e.message || 'Could not remove the line');
  }
};

// PUT /api/invoices/:id — whole-bill discount, comments, tax mode, guest contact.
exports.update = async (req, res) => {
  try {
    const inv = await Invoice.findById(req.params.id);
    if (!inv) return fail(res, 404, 'Invoice not found');
    const b = req.body || {};
    if (b.comments !== undefined) inv.comments = String(b.comments || '');
    if (inv.status === 'open') {
      if (b.invoiceDiscount) {
        inv.invoiceDiscount = { percent: Math.min(100, Math.max(0, Number(b.invoiceDiscount.percent) || 0)), amount: Math.max(0, Number(b.invoiceDiscount.amount) || 0), reason: String(b.invoiceDiscount.reason || '') };
      }
      if (b.interState !== undefined) inv.interState = !!b.interState;
      if (b.guest) for (const k of ['name', 'phone', 'email', 'gstin', 'stateCode']) if (b.guest[k] !== undefined) inv.guest[k] = b.guest[k] || null;
    } else if (b.invoiceDiscount || b.interState !== undefined) {
      return fail(res, 409, 'Reopen the invoice to change its discount or tax mode.', { code: 'INVOICE_NOT_OPEN' });
    }
    await inv.save();
    return send(res, await loadInvoice(inv._id));
  } catch (e) {
    return fail(res, 500, e.message || 'Could not update the invoice');
  }
};

/* ------------------------------------------------------------------------ */
/* Package benefits                                                          */
/* ------------------------------------------------------------------------ */

// POST /api/invoices/:id/redeem { packageAssignmentId, lineIds? }
exports.applyPackage = async (req, res) => {
  try {
    const inv = await Invoice.findById(req.params.id);
    if (!inv) return fail(res, 404, 'Invoice not found');
    if (!mustBeOpen(inv, res)) return;
    const pa = await PackageAssignment.findOne({ _id: req.body.packageAssignmentId, ...(inv.userId ? { userId: inv.userId } : {}) });
    if (!pa) return fail(res, 404, 'That package does not belong to this guest.');
    { const rd = pa.redeemable({ branchId: inv.branchId }); if (!rd.ok) return fail(res, 409, rd.message, { code: rd.code }); }
    const balances = pa.serviceBalances();
    const left = new Map(balances.map((r) => [String(r.serviceId), r.balance]));
    // Sessions already promised to this invoice's lines count against the balance too.
    for (const l of inv.lines) if (l.redeemed?.kind === 'package' && String(l.redeemed.packageAssignmentId) === String(pa._id) && l.refId) left.set(String(l.refId), (left.get(String(l.refId)) || 0) - 1);
    const only = Array.isArray(req.body.lineIds) && req.body.lineIds.length ? new Set(req.body.lineIds.map(String)) : null;
    let applied = 0;
    for (const l of inv.lines) {
      if (only && !only.has(String(l._id))) continue;
      if (l.kind !== 'service' || l.redeemed?.kind || !l.refId) continue;
      const key = String(l.refId);
      if ((left.get(key) || 0) <= 0) continue;
      l.redeemed = { kind: 'package', packageAssignmentId: pa._id, sessionId: null, label: `${pa.packageDetails?.packageName || 'Package'} — redeemed` };
      left.set(key, left.get(key) - 1);
      applied += 1;
    }
    if (!applied) return fail(res, 409, 'We cannot apply package benefits because the services on the invoice are not part of the package (or its balance is used up).', { code: 'NO_MATCHING_BENEFITS', balances });
    await inv.save();
    return send(res, await loadInvoice(inv._id), 200, { applied, message: 'Package benefits applied successfully' });
  } catch (e) {
    return fail(res, 500, e.message || 'Could not apply package benefits');
  }
};

// POST /api/invoices/:id/redeem-membership { lineIds? } — service credits on the guest's membership (MVP plans).
exports.applyMembershipCredits = async (req, res) => {
  try {
    const inv = await Invoice.findById(req.params.id);
    if (!inv) return fail(res, 404, 'Invoice not found');
    if (!mustBeOpen(inv, res)) return;
    const m = inv.userId ? await currentMembership(inv.userId) : null;
    if (!m || !m.assignment) return fail(res, 409, 'This guest has no membership with service credits.');
    const left = new Map(m.credits.map((c) => [String(c.serviceId), c.balance]));
    for (const l of inv.lines) if (l.redeemed?.kind === 'membership' && String(l.redeemed.membershipAssignmentId) === String(m.assignment._id)) { const k = creditKey(l, left); if (k) left.set(k, (left.get(k) || 0) - 1); }
    const only = Array.isArray(req.body?.lineIds) && req.body.lineIds.length ? new Set(req.body.lineIds.map(String)) : null;
    const cons = await Consultation.find({ _id: { $in: inv.lines.filter((l) => l.kind === 'service' && l.refId).map((l) => l.refId) } }).select('id').lean();
    const slugOf = new Map(cons.map((c) => [String(c._id), c.id]));
    let applied = 0;
    for (const l of inv.lines) {
      if (only && !only.has(String(l._id))) continue;
      if (l.kind !== 'service' || l.redeemed?.kind || !l.refId) continue;
      const key = [String(l.refId), slugOf.get(String(l.refId))].find((k) => k && (left.get(k) || 0) > 0);
      if (!key) continue;
      l.redeemed = { kind: 'membership', membershipAssignmentId: m.assignment._id, packageAssignmentId: null, sessionId: null, label: `${m.name} Service Credit Used` };
      l.discountPercent = 0; l.discount = 0; l.discountSource = null; l.discountLabel = null;
      left.set(key, left.get(key) - 1); applied += 1;
    }
    if (!applied) return fail(res, 409, 'No service on this invoice matches a credit left on the membership.', { code: 'NO_MATCHING_CREDITS', credits: m.credits });
    await inv.save();
    return send(res, await loadInvoice(inv._id), 200, { applied, message: 'Membership credits applied' });
  } catch (e) { return fail(res, 500, e.message || 'Could not apply membership credits'); }
};
function creditKey(l, left) { for (const k of left.keys()) if (k === String(l.refId)) return k; return null; }

exports.removeRedemption = async (req, res) => {
  try {
    const inv = await Invoice.findById(req.params.id);
    if (!inv) return fail(res, 404, 'Invoice not found');
    if (!mustBeOpen(inv, res)) return;
    const line = inv.lines.id(req.params.lineId);
    if (!line) return fail(res, 404, 'Line not found');
    line.redeemed = { kind: null, packageAssignmentId: null, sessionId: null, label: null };
    await inv.save();
    return send(res, await loadInvoice(inv._id));
  } catch (e) {
    return fail(res, 500, e.message || 'Could not remove the redemption');
  }
};

/* ------------------------------------------------------------------------ */
/* Tenders                                                                   */
/* ------------------------------------------------------------------------ */

// POST /api/invoices/:id/payments { method, amount, customName?, reference?, note? }
exports.addPayment = async (req, res) => {
  try {
    const inv = await Invoice.findById(req.params.id);
    if (!inv) return fail(res, 404, 'Invoice not found');
    if (!mustBeOpen(inv, res)) return;
    if (!inv.lines.length) return fail(res, 400, 'Add at least one line before taking a payment.');
    const { method, customName, reference, note } = req.body || {};
    const amount = Math.round((Number(req.body?.amount) || 0) * 100) / 100;
    if (!Invoice.METHODS.includes(method)) return fail(res, 400, `method must be one of ${Invoice.METHODS.join(', ')}`);
    if (!(amount > 0)) return fail(res, 400, 'amount must be greater than zero');
    if (method === 'Custom' && !String(customName || '').trim()) return fail(res, 400, 'Name the custom payment method (e.g. "UPI – PhonePe").');
    inv.recalc();
    if (method !== 'Cash' && amount > inv.totals.due + 0.005) return fail(res, 409, `Only ₹${inv.totals.due.toLocaleString('en-IN')} is due; a non-cash tender cannot exceed it.`, { code: 'OVERPAYMENT' });
    const me = who(req);
    inv.payments.push({ method, customName: customName || null, reference: reference || null, amount, paidAt: new Date(), takenById: me.id, takenByName: me.name, note: note || '' });
    if (!inv.receiptNumber) inv.receiptNumber = await issueReceiptNumber(await Branch.findById(inv.branchId), new Date());
    inv.recalc();
    let closed = false;
    if (inv.totals.due <= 0) { await applyClose(inv, me); closed = true; }
    else await inv.save();
    return send(res, await loadInvoice(inv._id), 200, { closed, message: closed ? 'Payment taken — invoice closed' : `Payment taken — ₹${inv.totals.due.toLocaleString('en-IN')} still due` });
  } catch (e) {
    console.error('Invoice payment error:', e);
    return fail(res, e.status || 500, e.message || 'Could not record the payment', e.extra || {});
  }
};

// DELETE /api/invoices/:id/payments/:paymentId { reason }
exports.voidPayment = async (req, res) => {
  try {
    const inv = await Invoice.findById(req.params.id);
    if (!inv) return fail(res, 404, 'Invoice not found');
    if (!mustBeOpen(inv, res)) return;
    const p = inv.payments.id(req.params.paymentId);
    if (!p) return fail(res, 404, 'Payment not found');
    if (p.voided) return fail(res, 409, 'That payment is already voided.');
    p.voided = true; p.voidedAt = new Date(); p.voidReason = String(req.body?.reason || '').trim() || `voided by ${who(req).name}`;
    await inv.save();
    return send(res, await loadInvoice(inv._id));
  } catch (e) {
    return fail(res, 500, e.message || 'Could not void the payment');
  }
};

/* ------------------------------------------------------------------------ */
/* Close / reopen / void                                                     */
/* ------------------------------------------------------------------------ */

const METHOD_TO_BOOKING = { Cash: 'Cash', Card: 'Card', UPI: 'UPI', Razorpay: 'Razorpay', Membership: 'Membership' };
function dominantMethod(inv) {
  const sums = {};
  for (const p of inv.payments) if (!p.voided) sums[p.method] = (sums[p.method] || 0) + p.amount;
  const top = Object.entries(sums).sort((a, b) => b[1] - a[1])[0];
  return top ? (METHOD_TO_BOOKING[top[0]] || 'Other') : 'Other';
}

/** Consume one session of `serviceId` on the assignment (a specific one when known). */
function consumeSession(pa, serviceId, sessionId, bookingId, invoiceId) {
  let s = sessionId ? pa.sessions.id(sessionId) : null;
  if (!s) s = pa.sessions.find((x) => String(x.serviceId) === String(serviceId) && ['Scheduled', 'Booked'].includes(x.status) && (!bookingId || !x.bookingId || String(x.bookingId) === String(bookingId)));
  if (!s) {
    const bal = pa.serviceBalances().find((r) => String(r.serviceId) === String(serviceId));
    if (!bal || bal.balance <= 0) throw Object.assign(new Error(`No ${bal?.serviceName || 'session'} balance left on ${pa.packageDetails?.packageName || 'the package'}.`), { status: 409 });
    pa.sessions.push({ serviceId: String(serviceId), serviceName: bal.serviceName || '', scheduledDate: new Date(), status: 'Completed', bookingId: bookingId || null, completedAt: new Date(), notes: `Redeemed on invoice ${invoiceId}` });
    s = pa.sessions[pa.sessions.length - 1];
  } else {
    s.status = 'Completed'; s.completedAt = new Date(); if (bookingId) s.bookingId = bookingId;
  }
  return s;
}

/**
 * The side effects of a bill closing, applied once (guarded by effectsAppliedAt
 * on the document): stock leaves the shelf first (it is the step that can
 * refuse), then visits are marked paid, package sessions consumed and sold
 * packages created.
 */
async function applyClose(inv, me, { allowDue = false } = {}) {
  inv.recalc();
  if (!inv.lines.length) throw Object.assign(new Error('Nothing to close — the invoice has no lines.'), { status: 400 });
  if (inv.totals.due > 0 && !allowDue) throw Object.assign(new Error(`₹${inv.totals.due.toLocaleString('en-IN')} is still due. Take the balance, or close with a balance due.`), { status: 409, extra: { code: 'DUE_OUTSTANDING', due: inv.totals.due } });
  const now = new Date();
  const fresh = !inv.effectsAppliedAt;
  if (fresh) {
    // 1. Stock (guarded decrements; refuses the whole close on a shortfall).
    for (const l of inv.lines) {
      if (l.kind !== 'product' || !(l.qty > 0)) continue;
      if (l.inventoryId) {
        const upd = await Inventory.findOneAndUpdate({ _id: l.inventoryId, qohAllBatches: { $gte: l.qty } }, { $inc: { qohAllBatches: -l.qty, qohBatchWise: -l.qty } }, { new: true });
        if (!upd) { const cur = await Inventory.findById(l.inventoryId).select('inventoryName qohAllBatches').lean(); throw Object.assign(new Error(`Not enough stock of ${cur?.inventoryName || l.name} (have ${cur?.qohAllBatches ?? 0}, selling ${l.qty}).`), { status: 409, extra: { code: 'INSUFFICIENT_STOCK', lineId: l._id } }); }
        await StockMovement.create({ inventoryId: upd._id, inventoryName: upd.inventoryName, batchNo: l.batchNo || upd.batchNo || '', type: 'sale', delta: -l.qty, before: upd.qohAllBatches + l.qty, after: upd.qohAllBatches, reason: `Invoice ${inv.invoiceNumber}`, bookingId: l.bookingId || null, branchId: inv.branchId, adminId: me.id, adminEmail: me.name });
      } else if (l.refModel === 'Product' && l.refId) {
        const p = await Product.findById(l.refId).select('trackStock stock name').lean();
        if (p && p.trackStock !== false) {
          const upd = await Product.findOneAndUpdate({ _id: p._id, stock: { $gte: l.qty } }, { $inc: { stock: -l.qty } }, { new: true });
          if (!upd) throw Object.assign(new Error(`Not enough stock of ${p.name} (have ${p.stock}, selling ${l.qty}).`), { status: 409, extra: { code: 'INSUFFICIENT_STOCK', lineId: l._id } });
        }
      }
    }
  }
  // 2. Visits.
  const method = dominantMethod(inv);
  const paidInFull = inv.totals.due <= 0;
  for (const l of inv.lines) {
    if (l.kind !== 'service' || !l.bookingId) continue;
    const set = { invoiceId: inv._id, amount: l.redeemed?.kind ? 0 : l.total, paymentMethod: l.redeemed?.kind ? 'Package' : method };
    if (paidInFull || l.redeemed?.kind) { set.paymentStatus = 'paid'; set.paidAt = now; }
    if (l.redeemed?.kind === 'package' && l.redeemed.packageAssignmentId) { set.isPackageIncluded = true; set.packageAssignmentId = l.redeemed.packageAssignmentId; }
    await Booking.updateOne({ _id: l.bookingId }, { $set: set });
  }
  if (fresh) {
    // 3. Package sessions consumed by redeemed lines.
    const byPa = new Map();
    for (const l of inv.lines) if (l.redeemed?.kind === 'package' && l.redeemed.packageAssignmentId) { const k = String(l.redeemed.packageAssignmentId); if (!byPa.has(k)) byPa.set(k, []); byPa.get(k).push(l); }
    for (const [paId, ls] of byPa) {
      const pa = await PackageAssignment.findById(paId);
      if (!pa) continue;
      { const rd = pa.redeemable({ branchId: inv.branchId }); if (!rd.ok) throw Object.assign(new Error(rd.message), { status: 409, extra: { code: rd.code } }); }
      for (const l of ls) {
        const s = consumeSession(pa, l.refId, l.redeemed.sessionId, l.bookingId, inv.invoiceNumber);
        l.redeemed.sessionId = s._id;
        packageRules.recordRedemption(pa, { serviceId: l.refId, serviceName: l.name, sessionId: s._id, bookingId: l.bookingId, invoiceId: inv._id, invoiceNumber: inv.invoiceNumber, branchId: inv.branchId, byName: me.name });
        if (l.bookingId) await Booking.updateOne({ _id: l.bookingId }, { $set: { packageSessionId: s._id } });
      }
      pa.checkCompletion();
      await pa.save();
    }
    // 3b. Membership service credits used on this bill.
    const byMa = new Map();
    for (const l of inv.lines) if (l.redeemed?.kind === 'membership' && l.redeemed.membershipAssignmentId) { const k = String(l.redeemed.membershipAssignmentId); if (!byMa.has(k)) byMa.set(k, []); byMa.get(k).push(l); }
    for (const [maId, ls] of byMa) {
      const ma = await MembershipAssignment.findById(maId);
      if (!ma || !ma.isCurrent()) throw Object.assign(new Error('The membership these credits come from is no longer active.'), { status: 409, extra: { code: 'MEMBERSHIP_INACTIVE' } });
      const cons = await Consultation.find({ _id: { $in: ls.map((l) => l.refId) } }).select('id').lean();
      const slugOf = new Map(cons.map((c) => [String(c._id), c.id]));
      for (const l of ls) {
        const c = (ma.credits || []).find((x) => [String(l.refId), slugOf.get(String(l.refId))].includes(String(x.serviceId)) && (x.qty - x.used) > 0);
        if (!c) throw Object.assign(new Error(`No ${l.name} credit left on the membership.`), { status: 409, extra: { code: 'NO_MATCHING_CREDITS' } });
        c.used += 1;
        ma.redemptions.push({ at: now, kind: 'credit', serviceId: c.serviceId, serviceName: l.name, amount: l.base, invoiceId: inv._id, invoiceNumber: inv.invoiceNumber, byName: me.name });
      }
      await ma.save();
    }
    // 3c. Member discounts taken, for the membership's own log.
    if (inv.membership?.assignmentId) {
      const disc = inv.lines.filter((l) => l.discountSource === 'membership').reduce((n, l) => n + (l.discount || 0), 0);
      if (disc > 0) await MembershipAssignment.updateOne({ _id: inv.membership.assignmentId }, { $push: { redemptions: { at: now, kind: 'discount', amount: r2(disc), invoiceId: inv._id, invoiceNumber: inv.invoiceNumber, byName: me.name } } });
    }
    // 4. Packages sold on this bill → live assignments, redeemable at once.
    for (const l of inv.lines) {
      if (l.kind !== 'package' || !l.refId || l.packageAssignmentId) continue;
      const pk = await Package.findById(l.refId);
      const user = inv.userId ? await User.findById(inv.userId) : null;
      if (!pk) continue;
      if (!user) throw Object.assign(new Error('A package can only be sold to a guest on record — pick the guest first.'), { status: 409, extra: { code: 'GUEST_REQUIRED' } });
      const minPct = Number(pk.minPartialPaymentPercent) || 0;
      if (!paidInFull && minPct > 0 && inv.totals.paid < r2(l.total * minPct / 100)) throw Object.assign(new Error(`${pk.name} needs at least ${minPct}% (₹${r2(l.total * minPct / 100).toLocaleString('en-IN')}) paid before the bill can close.`), { status: 409, extra: { code: 'MIN_PARTIAL_PAYMENT' } });
      const share = inv.totals.total > 0 ? r2(inv.totals.paid * l.total / inv.totals.total) : 0;
      const pa = packageRules.buildAssignment(pk, user, {
        branchId: inv.branchId, invoiceId: inv._id, listPrice: l.listTotal || pk.price, pricePaid: l.total,
        payment: { isReceived: paidInFull, receivedDate: now, paymentMethod: ['Cash', 'Card', 'UPI', 'Razorpay'].includes(method) ? method : 'Other', transactionId: inv.receiptNumber || inv.invoiceNumber, amountPaid: paidInFull ? l.total : share, balanceDue: paidInFull ? 0 : r2(l.total - share) },
        notes: `Sold on invoice ${inv.invoiceNumber}${l.total !== l.listTotal ? ` for ₹${l.total}` : ''}`, assignedBy: me.id, assignedByName: me.name,
      });
      pa.pricing.originalAmount = l.listTotal || pk.price;
      await pa.save();
      if (pa.pricing.finalAmount !== l.total) await PackageAssignment.updateOne({ _id: pa._id }, { $set: { 'pricing.finalAmount': l.total, 'pricing.discountAmount': r2((l.listTotal || pk.price) - l.total) } });
      l.packageAssignmentId = pa._id;
    }
    // 5. Memberships sold on this bill → member number issued, guest summary updated.
    for (const l of inv.lines) {
      if (l.kind !== 'membership' || !l.refId || l.membershipAssignmentId) continue;
      const plan = await Membership.findById(l.refId);
      const user = inv.userId ? await User.findById(inv.userId) : null;
      if (!plan) continue;
      if (!user) throw Object.assign(new Error('A membership can only be sold to a guest on record.'), { status: 409, extra: { code: 'GUEST_REQUIRED' } });
      const { createMemberAssignment } = require('./membershipController');
      const cur = await currentMembership(user._id);
      const ma = await createMemberAssignment(plan, user, { branchId: inv.branchId, paymentMethod: ['Cash', 'Card', 'UPI', 'Razorpay'].includes(method) ? method : 'Other', amount: l.total, paymentReceived: paidInFull, transactionId: inv.receiptNumber || inv.invoiceNumber, soldByName: me.name, extendFrom: cur?.validUntil || null, source: 'panel', invoiceId: inv._id, amountPaid: paidInFull ? l.total : null, balanceDue: paidInFull ? 0 : null });
      l.membershipAssignmentId = ma._id;
    }
    inv.effectsAppliedAt = now;
  }
  // Instalments: what has been collected against each package / membership sold here.
  for (const l of inv.lines) {
    if (l.kind === 'package' && l.packageAssignmentId) { const share = inv.totals.total > 0 ? r2(inv.totals.paid * l.total / inv.totals.total) : 0; await PackageAssignment.updateOne({ _id: l.packageAssignmentId }, { $set: { 'payment.isReceived': paidInFull, 'payment.receivedDate': paidInFull ? now : null, 'payment.amountPaid': paidInFull ? l.total : share, 'payment.balanceDue': paidInFull ? 0 : r2(l.total - share) } }); }
    if (l.kind === 'membership' && l.membershipAssignmentId) { const share = inv.totals.total > 0 ? r2(inv.totals.paid * l.total / inv.totals.total) : 0; await MembershipAssignment.updateOne({ _id: l.membershipAssignmentId }, { $set: { 'payment.isReceived': paidInFull, 'payment.receivedDate': paidInFull ? now : null, 'payment.amountPaid': paidInFull ? l.total : share, 'payment.balanceDue': paidInFull ? 0 : r2(l.total - share) } }); }
  }
  inv.status = 'closed'; inv.closedAt = now; inv.closedById = me.id; inv.closedByName = me.name;
  await inv.save();
  return inv;
}
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

exports.close = async (req, res) => {
  try {
    const inv = await Invoice.findById(req.params.id);
    if (!inv) return fail(res, 404, 'Invoice not found');
    if (!mustBeOpen(inv, res)) return;
    await applyClose(inv, who(req), { allowDue: !!req.body?.allowDue });
    return send(res, await loadInvoice(inv._id), 200, { message: 'Invoice closed' });
  } catch (e) {
    if (!e.status) console.error('Invoice close error:', e);
    return fail(res, e.status || 500, e.message || 'Could not close the invoice', e.extra || {});
  }
};

exports.reopen = async (req, res) => {
  try {
    const inv = await Invoice.findById(req.params.id);
    if (!inv) return fail(res, 404, 'Invoice not found');
    if (inv.status !== 'closed') return fail(res, 409, `Only a closed invoice can be reopened (this one is ${inv.status}).`);
    const me = who(req);
    inv.status = 'open'; inv.reopenedAt = new Date(); inv.reopenedByName = me.name;
    await inv.save();
    // Visits go back to "due" until the bill closes again; stock and package
    // effects stay (void reverses them).
    const ids = inv.lines.filter((l) => l.kind === 'service' && l.bookingId && !l.redeemed?.kind).map((l) => l.bookingId);
    if (ids.length) await Booking.updateMany({ _id: { $in: ids } }, { $set: { paymentStatus: 'pending' }, $unset: { paidAt: 1 } });
    return send(res, await loadInvoice(inv._id), 200, { message: 'Invoice reopened' });
  } catch (e) {
    return fail(res, 500, e.message || 'Could not reopen the invoice');
  }
};

exports.void = async (req, res) => {
  try {
    const inv = await Invoice.findById(req.params.id);
    if (!inv) return fail(res, 404, 'Invoice not found');
    if (inv.status === 'void') return fail(res, 409, 'Already void.');
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 3) return fail(res, 400, 'Give a reason for voiding this invoice.');
    const me = who(req); const now = new Date();
    if (inv.effectsAppliedAt) {
      for (const l of inv.lines) {
        if (l.kind === 'product' && l.qty > 0) {
          if (l.inventoryId) {
            const upd = await Inventory.findByIdAndUpdate(l.inventoryId, { $inc: { qohAllBatches: l.qty, qohBatchWise: l.qty } }, { new: true });
            if (upd) await StockMovement.create({ inventoryId: upd._id, inventoryName: upd.inventoryName, batchNo: l.batchNo || upd.batchNo || '', type: 'return', delta: l.qty, before: upd.qohAllBatches - l.qty, after: upd.qohAllBatches, reason: `Invoice ${inv.invoiceNumber} voided: ${reason}`, branchId: inv.branchId, adminId: me.id, adminEmail: me.name });
          } else if (l.refModel === 'Product' && l.refId) {
            const p = await Product.findById(l.refId).select('trackStock').lean();
            if (p && p.trackStock !== false) await Product.updateOne({ _id: l.refId }, { $inc: { stock: l.qty } });
          }
        }
        if (l.redeemed?.kind === 'package' && l.redeemed.packageAssignmentId && l.redeemed.sessionId) {
          const pa = await PackageAssignment.findById(l.redeemed.packageAssignmentId);
          const s = pa?.sessions.id(l.redeemed.sessionId);
          if (s) { s.status = 'Scheduled'; s.completedAt = null; if (pa.status === 'Completed') pa.status = 'Active'; packageRules.reverseRedemption(pa, { sessionId: s._id }); await pa.save(); }
        }
        if (l.kind === 'package' && l.packageAssignmentId) {
          await PackageAssignment.updateOne({ _id: l.packageAssignmentId }, { $set: { status: 'Cancelled', notes: `Invoice ${inv.invoiceNumber} voided: ${reason}` } });
        }
        if (l.redeemed?.kind === 'membership' && l.redeemed.membershipAssignmentId) {
          const ma = await MembershipAssignment.findById(l.redeemed.membershipAssignmentId);
          if (ma) { const c = (ma.credits || []).find((x) => x.used > 0 && (String(x.serviceId) === String(l.refId) || (ma.redemptions || []).some((r) => String(r.invoiceId) === String(inv._id) && r.serviceId === x.serviceId && !r.reversed))); if (c) c.used = Math.max(0, c.used - 1); for (const r of ma.redemptions || []) if (String(r.invoiceId) === String(inv._id)) r.reversed = true; await ma.save(); }
        }
        if (l.kind === 'membership' && l.membershipAssignmentId) {
          const ma = await MembershipAssignment.findById(l.membershipAssignmentId);
          if (ma) { ma.status = 'Cancelled'; ma.cancellation = { cancelledAt: now, byName: me.name, reason: `Invoice ${inv.invoiceNumber} voided: ${reason}` }; await ma.save(); await syncUserMembership(ma.userId); }
        }
      }
    }
    const ids = inv.lines.filter((l) => l.kind === 'service' && l.bookingId).map((l) => l.bookingId);
    if (ids.length) await Booking.updateMany({ _id: { $in: ids }, invoiceId: inv._id }, { $set: { invoiceId: null, paymentStatus: 'pending' }, $unset: { paidAt: 1 } });
    for (const p of inv.payments) if (!p.voided) { p.voided = true; p.voidedAt = now; p.voidReason = `Invoice voided: ${reason}`; }
    inv.status = 'void'; inv.voidedAt = now; inv.voidedById = me.id; inv.voidedByName = me.name; inv.voidReason = reason;
    await inv.save();
    return send(res, await loadInvoice(inv._id), 200, { message: 'Invoice voided' });
  } catch (e) {
    console.error('Invoice void error:', e);
    return fail(res, 500, e.message || 'Could not void the invoice');
  }
};

/* ------------------------------------------------------------------------ */
/* Receipt: print / email / WhatsApp                                         */
/* ------------------------------------------------------------------------ */

// GET /api/invoices/:id/receipt?format=html|json&print=1
exports.receipt = async (req, res) => {
  try {
    const inv = await loadInvoice(req.params.id);
    if (!inv) return fail(res, 404, 'Invoice not found');
    const html = renderReceiptHtml(inv, { printedBy: who(req).name, printedAt: new Date() });
    if (req.query.print === '1') await Invoice.updateOne({ _id: inv._id }, { $inc: { printedCount: 1 }, $set: { lastPrintedAt: new Date() } });
    if (req.query.format === 'html') { res.type('html'); return res.send(`<!doctype html><html><head><meta charset="utf-8"><title>${inv.invoiceNumber}</title></head><body>${html}</body></html>`); }
    return res.json({ success: true, data: { html, text: receiptText(inv), invoiceNumber: inv.invoiceNumber, receiptNumber: inv.receiptNumber } });
  } catch (e) {
    return fail(res, 500, e.message || 'Could not render the receipt');
  }
};

// POST /api/invoices/:id/send { channel: 'email' | 'whatsapp' | 'both', email?, phone? }
exports.sendReceipt = async (req, res) => {
  try {
    const inv = await loadInvoice(req.params.id);
    if (!inv) return fail(res, 404, 'Invoice not found');
    const channel = req.body?.channel || 'email';
    const email = String(req.body?.email || inv.guest?.email || '').trim();
    const phone = String(req.body?.phone || inv.guest?.phone || '').trim();
    const out = {};
    if (channel === 'email' || channel === 'both') {
      if (!email) out.email = { ok: false, error: 'No email on file' };
      else {
        try {
          const { sendInvoiceEmail } = require('../utils/emailService');
          await sendInvoiceEmail(email, inv.guest?.name, { html: renderReceiptHtml(inv, { printedBy: who(req).name }), invoiceNumber: inv.invoiceNumber, total: inv.totals?.total, centre: inv.seller?.name });
          out.email = { ok: true, to: email }; inv.emailedAt = new Date();
          if (email && email !== inv.guest?.email) inv.guest.email = email;
        } catch (e) { out.email = { ok: false, error: e.message }; }
      }
    }
    if (channel === 'whatsapp' || channel === 'both') {
      if (!phone) out.whatsapp = { ok: false, error: 'No phone on file' };
      else {
        try {
          const wa = require('../services/whatsappService');
          const r = await wa.sendMessage(phone, receiptText(inv));
          out.whatsapp = r?.success ? { ok: true, to: phone } : { ok: false, error: r?.error || 'WhatsApp not sent' };
          if (r?.success) inv.whatsappedAt = new Date();
        } catch (e) { out.whatsapp = { ok: false, error: e.message }; }
      }
    }
    await inv.save();
    const ok = Object.values(out).some((r) => r.ok);
    return res.status(ok ? 200 : 502).json({ success: ok, data: out, message: ok ? 'Receipt sent' : 'Receipt could not be sent' });
  } catch (e) {
    return fail(res, 500, e.message || 'Could not send the receipt');
  }
};

/* ------------------------------------------------------------------------ */
/* Guest's packages for the "Packages" dropdown on the bill                  */
/* ------------------------------------------------------------------------ */

// GET /api/invoices/:id/packages — the guest's active packages with balances.
exports.guestPackages = async (req, res) => {
  try {
    const inv = await Invoice.findById(req.params.id).select('userId').lean();
    if (!inv) return fail(res, 404, 'Invoice not found');
    if (!inv.userId) return res.json({ success: true, data: [] });
    const invDoc = await Invoice.findById(req.params.id).select('branchId').lean();
    const rows = await PackageAssignment.find({ userId: inv.userId, status: 'Active' }).sort({ createdAt: -1 });
    const m = await currentMembership(inv.userId);
    return res.json({ success: true, data: rows.map((pa) => ({ _id: pa._id, assignmentId: pa.assignmentId, name: pa.packageDetails?.packageName, validUntil: pa.validUntil, graceUntil: pa.graceUntil, frozen: !!pa.freeze?.isFrozen, redeemable: pa.redeemable({ branchId: invDoc?.branchId }), balances: pa.serviceBalances() })),
      membership: m ? { kind: m.kind, name: m.name, memberNumber: m.memberNumber, validUntil: m.validUntil, discounts: m.discounts, credits: m.credits, assignmentId: m.assignment?._id || null } : null });
  } catch (e) {
    return fail(res, 500, e.message || 'Could not load packages');
  }
};

exports._internal = { applyClose, lineFromBooking, buildLine };
