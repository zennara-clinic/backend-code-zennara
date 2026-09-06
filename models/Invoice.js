const mongoose = require('mongoose');

/**
 * A desk bill — the document Zenoti calls an invoice.
 *
 * One invoice per visit (or counter sale). It carries the LINES sold
 * (services, products, packages, memberships, custom), the TENDERS taken
 * against it (cash, card, UPI, a custom method, membership credit …), and the
 * GST arithmetic the receipt prints. A bill is OPEN while the desk works on
 * it, CLOSED once settled, VOID if cancelled after the fact (the number is
 * kept — GST sequences must not have holes).
 *
 * Numbers: `<centre prefix><yy><seq>` for invoices (ZNJH26 0001) and
 * `<prefix><yy>R<seq>` for receipts, per centre per financial year, issued by
 * Counter.next(). The receipt number is assigned when the first payment is
 * taken, as in Zenoti.
 *
 * Money: unit prices are stored as entered plus a flag saying whether they
 * include tax. Everything else (base, discount, tax split, rounding, totals)
 * is recomputed by `recalc()` on every save so the stored figures can never
 * disagree with the lines. Line discounts and the invoice discount are
 * pre-tax amounts. A line REDEEMED against a package or membership credit
 * keeps its list price but bills ₹0 (Zenoti's "Final Price 0.00").
 *
 * This is the local bill only. Nothing here writes to Zenoti.
 */

const METHODS = ['Cash', 'Card', 'UPI', 'Custom', 'Razorpay', 'Membership', 'Prepaid', 'GiftCard', 'Points', 'BankTransfer', 'Cheque'];
const LINE_KINDS = ['service', 'product', 'package', 'membership', 'custom'];

const lineSchema = new mongoose.Schema({
  kind: { type: String, enum: LINE_KINDS, required: true },
  /** What was sold: Consultation / Product / Inventory / Package id. */
  refId: { type: mongoose.Schema.Types.ObjectId, default: null },
  refModel: { type: String, enum: ['Consultation', 'Product', 'Inventory', 'Package', null], default: null },
  /** The visit row this service line settles (service lines only). */
  bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', default: null },
  name: { type: String, required: true, trim: true },
  code: { type: String, default: null, trim: true },
  /** HSN for goods, SAC for services — printed on the GST receipt. */
  hsn: { type: String, default: null, trim: true },
  qty: { type: Number, default: 1, min: 0 },
  unitPrice: { type: Number, default: 0, min: 0 },
  priceIncludesTax: { type: Boolean, default: true },
  taxPercent: { type: Number, default: 0, min: 0 },
  /** Pre-tax discount on this line, in rupees (percent is a UI convenience). */
  discount: { type: Number, default: 0, min: 0 },
  discountPercent: { type: Number, default: 0, min: 0, max: 100 },
  /** Set when the line is paid for out of a package / membership credit. */
  redeemed: {
    kind: { type: String, enum: ['package', 'membership', null], default: null },
    packageAssignmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'PackageAssignment', default: null },
    sessionId: { type: mongoose.Schema.Types.ObjectId, default: null },
    label: { type: String, default: null },
  },
  /** "Sale by" — who gets the attribution (a Doctor or an Admin/staff login). */
  soldById: { type: String, default: null },
  soldByName: { type: String, default: null, trim: true },
  soldByModel: { type: String, enum: ['Doctor', 'Admin', null], default: null },
  /** Pharmacy lines: which batch left the shelf. */
  batchNo: { type: String, default: null, trim: true },
  expiryDate: { type: Date, default: null },
  inventoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Inventory', default: null },
  /** Package lines: the PackageAssignment created when the bill closed. */
  packageAssignmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'PackageAssignment', default: null },
  notes: { type: String, default: '', trim: true },
  // ---- computed by recalc() ----
  listTotal: { type: Number, default: 0 },   // unitPrice × qty as entered
  base: { type: Number, default: 0 },        // pre-tax gross
  invoiceDiscountShare: { type: Number, default: 0 },
  net: { type: Number, default: 0 },         // base − discounts
  tax: { type: Number, default: 0 },
  total: { type: Number, default: 0 },       // net + tax (0 when redeemed)
}, { _id: true });

const paymentSchema = new mongoose.Schema({
  method: { type: String, enum: METHODS, required: true },
  /** Free text for Custom ("UPI - PhonePe"), or the card/UPI reference. */
  customName: { type: String, default: null, trim: true },
  reference: { type: String, default: null, trim: true },
  amount: { type: Number, required: true, min: 0.01 },
  paidAt: { type: Date, default: Date.now },
  takenById: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  takenByName: { type: String, default: null },
  note: { type: String, default: '', trim: true },
  /** The Razorpay Payment row when the tender came from the app. */
  paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', default: null },
  voided: { type: Boolean, default: false },
  voidedAt: { type: Date, default: null },
  voidReason: { type: String, default: null },
}, { _id: true });

const invoiceSchema = new mongoose.Schema({
  invoiceNumber: { type: String, required: true, unique: true, index: true },
  receiptNumber: { type: String, default: null, index: true },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  /** Snapshot of the centre's legal block at issue time, for reprints. */
  seller: {
    name: { type: String, default: null },
    legalName: { type: String, default: null },
    gstin: { type: String, default: null },
    pan: { type: String, default: null },
    stateCode: { type: String, default: null },
    address: { type: String, default: null },
    phone: { type: String, default: null },
    email: { type: String, default: null },
  },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  guest: {
    name: { type: String, default: null, trim: true },
    phone: { type: String, default: null, trim: true },
    email: { type: String, default: null, trim: true },
    patientId: { type: String, default: null },
    gender: { type: String, default: null },
    stateCode: { type: String, default: null },
    gstin: { type: String, default: null },
  },
  /** Several bookings settled by this bill share `visitGroupId`. */
  visitGroupId: { type: String, default: null, index: true },
  status: { type: String, enum: ['open', 'closed', 'void'], default: 'open', index: true },
  source: { type: String, enum: ['desk', 'app', 'zenoti'], default: 'desk' },
  lines: { type: [lineSchema], default: [] },
  payments: { type: [paymentSchema], default: [] },
  /** Whole-bill discount, pre-tax: a percent OR a rupee amount (percent wins). */
  invoiceDiscount: {
    percent: { type: Number, default: 0, min: 0, max: 100 },
    amount: { type: Number, default: 0, min: 0 },
    reason: { type: String, default: '', trim: true },
  },
  coupon: { code: { type: String, default: null }, discount: { type: Number, default: 0 } },
  /** IGST instead of CGST+SGST when the guest's state differs from the centre's. */
  interState: { type: Boolean, default: false },
  totals: {
    listTotal: { type: Number, default: 0 },
    base: { type: Number, default: 0 },
    lineDiscount: { type: Number, default: 0 },
    invoiceDiscount: { type: Number, default: 0 },
    redeemed: { type: Number, default: 0 },      // list value settled by credits
    net: { type: Number, default: 0 },
    tax: { type: Number, default: 0 },
    cgst: { type: Number, default: 0 },
    sgst: { type: Number, default: 0 },
    igst: { type: Number, default: 0 },
    rawTotal: { type: Number, default: 0 },
    rounding: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    paid: { type: Number, default: 0 },
    due: { type: Number, default: 0 },
    change: { type: Number, default: 0 },
  },
  /** Per-rate tax summary for the receipt: [{ rate, taxable, tax }]. */
  taxSummary: { type: [{ rate: Number, taxable: Number, tax: Number, _id: false }], default: [] },
  comments: { type: String, default: '', trim: true },
  issuedAt: { type: Date, default: Date.now, index: true },
  closedAt: { type: Date, default: null, index: true },
  closedById: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  closedByName: { type: String, default: null },
  reopenedAt: { type: Date, default: null },
  reopenedByName: { type: String, default: null },
  voidedAt: { type: Date, default: null },
  voidedById: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  voidedByName: { type: String, default: null },
  voidReason: { type: String, default: null },
  createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  createdByName: { type: String, default: null },
  /** When closing's side effects (stock, sessions, sold packages) ran — once per bill. */
  effectsAppliedAt: { type: Date, default: null },
  printedCount: { type: Number, default: 0 },
  lastPrintedAt: { type: Date, default: null },
  emailedAt: { type: Date, default: null },
  whatsappedAt: { type: Date, default: null },
  /** Zenoti's invoice id/number when this bill mirrors one (read-only). */
  zenotiInvoiceId: { type: String, default: null, index: true },
  zenotiInvoiceNumber: { type: String, default: null },
  /** What the bill settles (denormalised for search). */
  bookingIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
}, { timestamps: true });

invoiceSchema.index({ branchId: 1, issuedAt: -1 });
invoiceSchema.index({ branchId: 1, closedAt: -1 });
invoiceSchema.index({ 'guest.phone': 1 });
invoiceSchema.index({ bookingIds: 1 });

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Recompute every derived figure from the lines and tenders. */
invoiceSchema.methods.recalc = function () {
  const lines = this.lines || [];
  // Pass 1 — per-line pre-tax base and own discount.
  let baseSum = 0;
  for (const l of lines) {
    const qty = Number(l.qty) || 0;
    const unit = Number(l.unitPrice) || 0;
    const t = Number(l.taxPercent) || 0;
    l.listTotal = r2(unit * qty);
    const gross = l.priceIncludesTax ? l.listTotal / (1 + t / 100) : l.listTotal;
    l.base = r2(gross);
    if (l.discountPercent > 0) l.discount = r2(l.base * l.discountPercent / 100);
    l.discount = Math.min(r2(l.discount || 0), l.base);
    if (!l.redeemed?.kind) baseSum += l.base - l.discount;
  }
  // Pass 2 — spread the whole-bill discount across the billable lines.
  const idPct = Number(this.invoiceDiscount?.percent) || 0;
  let idAmt = idPct > 0 ? r2(baseSum * idPct / 100) : Math.min(r2(this.invoiceDiscount?.amount || 0), baseSum);
  if (this.coupon?.discount > 0) idAmt = Math.min(baseSum, idAmt + r2(this.coupon.discount));
  let spread = 0;
  const billable = lines.filter((l) => !l.redeemed?.kind && (l.base - l.discount) > 0);
  billable.forEach((l, i) => {
    const after = l.base - l.discount;
    const share = i === billable.length - 1 ? r2(idAmt - spread) : r2(idAmt * after / baseSum);
    l.invoiceDiscountShare = Math.max(0, Math.min(after, share));
    spread += l.invoiceDiscountShare;
  });
  // Pass 3 — net, tax, total per line and the tax summary.
  const byRate = new Map();
  const T = { listTotal: 0, base: 0, lineDiscount: 0, invoiceDiscount: 0, redeemed: 0, net: 0, tax: 0 };
  for (const l of lines) {
    const t = Number(l.taxPercent) || 0;
    T.listTotal += l.listTotal;
    if (l.redeemed?.kind) {
      l.invoiceDiscountShare = 0; l.net = 0; l.tax = 0; l.total = 0;
      T.redeemed += l.base;
      continue;
    }
    l.net = r2(l.base - l.discount - (l.invoiceDiscountShare || 0));
    l.tax = r2(l.net * t / 100);
    l.total = r2(l.net + l.tax);
    T.base += l.base; T.lineDiscount += l.discount; T.invoiceDiscount += l.invoiceDiscountShare || 0; T.net += l.net; T.tax += l.tax;
    const row = byRate.get(t) || { rate: t, taxable: 0, tax: 0 };
    row.taxable = r2(row.taxable + l.net); row.tax = r2(row.tax + l.tax);
    byRate.set(t, row);
  }
  this.taxSummary = [...byRate.values()].sort((a, b) => a.rate - b.rate);
  const raw = r2(T.net + T.tax);
  const total = Math.round(raw);
  const paid = r2((this.payments || []).filter((p) => !p.voided).reduce((n, p) => n + (Number(p.amount) || 0), 0));
  this.totals = {
    listTotal: r2(T.listTotal), base: r2(T.base), lineDiscount: r2(T.lineDiscount), invoiceDiscount: r2(T.invoiceDiscount), redeemed: r2(T.redeemed),
    net: r2(T.net), tax: r2(T.tax),
    cgst: this.interState ? 0 : r2(T.tax / 2), sgst: this.interState ? 0 : r2(T.tax / 2), igst: this.interState ? r2(T.tax) : 0,
    rawTotal: raw, rounding: r2(total - raw), total,
    paid, due: Math.max(0, r2(total - paid)), change: Math.max(0, r2(paid - total)),
  };
  return this.totals;
};

invoiceSchema.pre('validate', function (next) { this.recalc(); next(); });

invoiceSchema.statics.METHODS = METHODS;
invoiceSchema.statics.LINE_KINDS = LINE_KINDS;

module.exports = mongoose.model('Invoice', invoiceSchema);
