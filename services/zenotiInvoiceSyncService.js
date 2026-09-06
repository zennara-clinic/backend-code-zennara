/**
 * Zenoti invoices → our Invoice collection (read-only mirror).
 *
 * Zenoti is the system of record for everything billed at the clinic before
 * our desk existed: 36,000+ invoices sit behind the appointments we already
 * mirror. `GET /v1/invoices/{id}` returns the header (number, receipt number,
 * closed/refund, date, centre, net / tax / rounding / total). Line items and
 * payments each need their OWN call (`?expand=InvoiceItems`, `?expand=
 * Transactions` — Zenoti ignores a combined expand), so they are pulled only
 * when someone actually opens the bill, or by a deliberate backfill.
 *
 * Nothing here writes to Zenoti. A mirrored invoice is never recalculated
 * locally (see models/Invoice.js) and the desk cannot edit it.
 */
const mongoose = require('mongoose');
const Invoice = require('../models/Invoice');
const Booking = require('../models/Booking');
const Branch = require('../models/Branch');
const User = require('../models/User');
const zenoti = require('./zenotiService');
const logger = require('../utils/logger');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const norm = (v) => (v === null || v === undefined ? null : String(v).trim() || null);

/** Zenoti invoice-item `type` → our line kind. */
const ITEM_KIND = { 0: 'service', 1: 'product', 2: 'package', 3: 'membership', 4: 'membership', 5: 'custom' };
/** Zenoti payment names → our tender methods. */
function methodFor(name) {
  const n = String(name || '').toUpperCase();
  if (n.includes('CASH')) return { method: 'Cash', customName: null };
  if (n.includes('CREDIT') || n.includes('DEBIT') || n.includes('CARD')) return { method: 'Card', customName: null };
  if (n.includes('UPI')) return { method: 'UPI', customName: null };
  if (n.includes('CHEQUE') || n.includes('CHECK')) return { method: 'Cheque', customName: null };
  if (n.includes('MEMBERSHIP')) return { method: 'Membership', customName: null };
  if (n.includes('PREPAID') || n.includes('GIFT')) return { method: 'Prepaid', customName: null };
  if (n.includes('POINT')) return { method: 'Points', customName: null };
  if (n.includes('BANK') || n.includes('NEFT') || n.includes('TRANSFER')) return { method: 'BankTransfer', customName: null };
  return { method: 'Custom', customName: name || 'Other' };
}

let branchCache = { at: 0, byCentre: new Map() };
async function branchByCentre(centerId) {
  if (Date.now() - branchCache.at > 5 * 60 * 1000) {
    const rows = await Branch.find({ zenotiCenterId: { $ne: null } }).select('name zenotiCenterId invoicePrefix legalName gstin pan stateCode address contact').lean();
    branchCache = { at: Date.now(), byCentre: new Map(rows.map((b) => [String(b.zenotiCenterId).toLowerCase(), b])) };
  }
  return branchCache.byCentre.get(String(centerId || '').toLowerCase()) || null;
}

/**
 * Mirror one Zenoti invoice. `detail: true` also pulls its line items and
 * payments (two extra API calls) — do that when a human opens the bill.
 */
async function mirrorInvoice(zenotiInvoiceId, { detail = false, booking = null } = {}) {
  const id = String(zenotiInvoiceId || '').trim();
  if (!id) return { outcome: 'skipped', reason: 'no id' };

  const head = (await zenoti.request(`/v1/invoices/${id}`))?.invoice;
  if (!head) return { outcome: 'failed', reason: 'not found in Zenoti' };

  let branch = await branchByCentre(head.center_id);
  // A centre we do not mirror (or a bill with no centre on it) still belongs
  // somewhere: fall back to the visit's own centre, then the default clinic,
  // so the register never loses a bill over a mapping gap.
  if (!branch && booking?.branchId) branch = await Branch.findById(booking.branchId).select('name zenotiCenterId invoicePrefix legalName gstin pan stateCode address contact').lean();
  if (!branch) branch = await Branch.findOne({ centreType: 'clinic', isActive: true }).sort({ displayOrder: 1 }).select('name zenotiCenterId invoicePrefix legalName gstin pan stateCode address contact').lean();
  const number = `${head.invoice_number_prefix || ''}${head.invoice_number || ''}`.trim() || `ZEN-${id.slice(0, 8)}`;
  let inv = await Invoice.findOne({ zenotiInvoiceId: id });
  if (!inv) inv = await Invoice.findOne({ invoiceNumber: number, source: 'zenoti' });
  const isNew = !inv;
  if (!inv) inv = new Invoice({ invoiceNumber: number, source: 'zenoti', branchId: branch?._id || null });

  // A mirrored bill is read-only here: status follows Zenoti.
  inv.source = 'zenoti';
  inv.zenotiInvoiceId = id;
  inv.zenotiInvoiceNumber = String(head.invoice_number || '');
  inv.invoiceNumber = number;
  inv.receiptNumber = norm(head.receipt_number);
  if (branch?._id) inv.branchId = branch._id;
  if (branch) {
    inv.seller = {
      name: branch.name, legalName: branch.legalName || null, gstin: branch.gstin || null, pan: branch.pan || null, stateCode: branch.stateCode || null,
      address: [branch.address?.line1, branch.address?.city, branch.address?.pincode].filter(Boolean).join(', ') || null,
      phone: Array.isArray(branch.contact?.phone) ? branch.contact.phone[0] : branch.contact?.phone || null,
      email: branch.contact?.email || null,
    };
  }
  const t = head.total_price || {};
  const total = r2(t.sum_total);
  const net = r2(t.net_price);
  const tax = r2(t.tax);
  inv.status = head.is_closed ? 'closed' : 'open';
  inv.issuedAt = head.invoice_date ? new Date(head.invoice_date) : inv.issuedAt;
  if (head.is_closed) inv.closedAt = inv.closedAt || (head.invoice_date ? new Date(head.invoice_date) : new Date());
  inv.zenotiSource = {
    ...(inv.zenotiSource || {}),
    invoiceNumber: number, receiptNumber: norm(head.receipt_number), isClosed: !!head.is_closed, isRefund: !!head.is_refund,
    appointmentGroupId: norm(head.appointment_group_id), centerId: norm(head.center_id),
    invoiceDate: head.invoice_date ? new Date(head.invoice_date) : null, syncedAt: new Date(),
  };

  if (detail) {
    const [itemsRes, txnRes] = await Promise.all([
      zenoti.request(`/v1/invoices/${id}`, { query: { expand: 'InvoiceItems' } }).catch(() => null),
      zenoti.request(`/v1/invoices/${id}`, { query: { expand: 'Transactions' } }).catch(() => null),
    ]);
    const items = itemsRes?.invoice?.invoice_items;
    const guest = itemsRes?.invoice?.guest;
    if (Array.isArray(items)) {
      inv.lines = items.map((it) => {
        const p = it.price || {};
        const qty = Number(it.quantity) || 1;
        const final = r2(p.final);
        const sales = r2(p.sales);
        const itemTax = r2(p.tax);
        return {
          kind: ITEM_KIND[it.type] || 'custom',
          name: it.name || 'Item', code: norm(it.code), qty,
          // Zenoti gives the LINE totals; store a unit price that multiplies back.
          unitPrice: qty > 0 ? r2(final / qty) : final,
          priceIncludesTax: true,
          taxPercent: sales > 0 ? r2((itemTax / sales) * 100) : 0,
          discount: r2(p.discount),
          soldByName: norm(it.therapist_name), soldById: norm(it.sale_by_id), soldByModel: null,
          listTotal: final, base: sales, invoiceDiscountShare: 0, net: sales, tax: itemTax, total: final,
        };
      });
    }
    if (guest) {
      inv.guest = {
        name: [guest.first_name, guest.last_name].filter(Boolean).join(' ').trim() || inv.guest?.name || null,
        phone: norm(guest.mobile_phone) || inv.guest?.phone || null,
        email: norm(guest.email) || inv.guest?.email || null,
        patientId: norm(guest.code) || inv.guest?.patientId || null,
        gender: guest.gender === 1 ? 'Male' : guest.gender === 0 ? 'Female' : inv.guest?.gender || null,
        stateCode: inv.guest?.stateCode || null, gstin: inv.guest?.gstin || null,
      };
      inv.zenotiSource.guestId = norm(guest.id);
      inv.zenotiSource.guestCode = norm(guest.code);
      if (!inv.userId && guest.id) {
        const u = await User.findOne({ zenotiGuestId: String(guest.id).toLowerCase() }).select('_id').lean();
        if (u) inv.userId = u._id;
      }
    }
    const txns = txnRes?.invoice?.transactions;
    if (Array.isArray(txns)) {
      inv.payments = txns.map((x) => {
        const m = methodFor(x.payment_option?.payment_name);
        return {
          method: m.method, customName: m.customName, reference: norm(x.transaction_id),
          amount: r2(x.amount_paid ?? x.total_amount_paid) || 0.01,
          paidAt: x.payment_date ? new Date(x.payment_date) : (inv.issuedAt || new Date()),
          takenByName: 'Zenoti', note: x.tip_amount ? `Tip ₹${x.tip_amount}` : '',
        };
      }).filter((p) => p.amount > 0);
    }
    inv.zenotiSource.detailFetchedAt = new Date();
  }

  // Totals always come from Zenoti's header, never from our recalc.
  const paid = r2((inv.payments || []).filter((p) => !p.voided).reduce((n, p) => n + (Number(p.amount) || 0), 0));
  inv.totals = {
    listTotal: total, base: net, lineDiscount: r2((inv.lines || []).reduce((n, l) => n + (l.discount || 0), 0)), invoiceDiscount: 0, redeemed: 0,
    net, tax, cgst: r2(tax / 2), sgst: r2(tax / 2), igst: 0,
    rawTotal: r2(net + tax), rounding: r2(t.rounding_adjustment), total,
    paid: inv.zenotiSource.detailFetchedAt ? paid : (head.is_closed ? total : 0),
    due: head.is_closed ? 0 : r2(total - (inv.zenotiSource.detailFetchedAt ? paid : 0)),
    change: 0,
  };
  inv.taxSummary = tax > 0 ? [{ rate: net > 0 ? r2((tax / net) * 100) : 0, taxable: net, tax }] : [];

  if (booking && !inv.bookingIds?.some((b) => String(b) === String(booking._id))) inv.bookingIds = [...(inv.bookingIds || []), booking._id];
  if (booking && !inv.userId && booking.userId) inv.userId = booking.userId;
  if (booking && !inv.guest?.name) inv.guest = { ...(inv.guest || {}), name: booking.fullName || null, phone: booking.mobileNumber || null };

  await inv.save();
  if (booking && !booking.invoiceId) await Booking.updateOne({ _id: booking._id }, { $set: { invoiceId: inv._id } });
  return { outcome: isNew ? 'created' : 'updated', invoiceId: inv._id, number };
}

/**
 * Mirror the invoices behind recently mirrored appointments. Header-only (one
 * call per invoice) and capped, so the hourly job stays cheap.
 */
async function syncRecentInvoices({ days = 7, limit = 150, detail = false, trigger = 'schedule' } = {}) {
  if (!zenoti.isConfigured()) return { skipped: true };
  const since = new Date(Date.now() - days * 86400000);
  // Only visits that have already happened: Zenoti opens an invoice the moment
  // an appointment is booked, so mirroring future ones would fill the register
  // with empty bills and overstate what is outstanding.
  const bookings = await Booking.find({
    source: 'zenoti', zenotiInvoiceId: { $ne: null },
    $or: [{ invoiceId: null }, { invoiceId: { $exists: false } }],
    preferredDate: { $gte: since, $lte: new Date() },
  }).select('_id zenotiInvoiceId userId fullName mobileNumber branchId').sort({ preferredDate: -1 }).limit(limit).lean();

  const stats = { considered: bookings.length, created: 0, updated: 0, failed: 0, days, detail };
  const seen = new Set();
  for (const b of bookings) {
    if (seen.has(b.zenotiInvoiceId)) continue;
    seen.add(b.zenotiInvoiceId);
    try {
      const r = await mirrorInvoice(b.zenotiInvoiceId, { detail, booking: b });
      if (r.outcome === 'created') stats.created += 1; else if (r.outcome === 'updated') stats.updated += 1;
    } catch (error) {
      stats.failed += 1;
      if (stats.failed <= 3) logger.warn('Zenoti invoice mirror failed', { zenotiInvoiceId: b.zenotiInvoiceId, error: error.message });
    }
  }
  logger.info('Zenoti invoice sync finished', { trigger, ...stats });
  return stats;
}

/** The bill behind one booking, fetched in full and cached from then on. */
async function invoiceForBooking(bookingId, { refresh = false } = {}) {
  const booking = await Booking.findById(bookingId).select('_id zenotiInvoiceId invoiceId userId fullName mobileNumber').lean();
  if (!booking) throw Object.assign(new Error('Booking not found'), { status: 404 });
  if (booking.invoiceId && !refresh) {
    const existing = await Invoice.findById(booking.invoiceId);
    if (existing && (existing.source !== 'zenoti' || existing.zenotiSource?.detailFetchedAt)) return existing;
  }
  if (!booking.zenotiInvoiceId) throw Object.assign(new Error('This visit has no Zenoti invoice.'), { status: 404 });
  const r = await mirrorInvoice(booking.zenotiInvoiceId, { detail: true, booking });
  return Invoice.findById(r.invoiceId);
}

module.exports = { mirrorInvoice, syncRecentInvoices, invoiceForBooking };
