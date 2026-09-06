const mongoose = require('mongoose');

/**
 * A stock audit — Zenoti's Inventory › Audit + Reconcile.
 *
 * A count sheet is opened for one centre (optionally one category / vendor):
 * every stock row's on-hand quantity is frozen as `expected`. Staff enter
 * `counted` per line (in the panel or by CSV), submit, and a manager
 * reconciles: each variance becomes an `adjust` ledger row that brings the
 * shelf to the counted figure, the sheet is locked, and the centre's "last
 * reconcile date" moves. Stock value before/after is kept for the dashboard.
 */
const lineSchema = new mongoose.Schema({
  inventoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Inventory', required: true },
  name: { type: String, default: '' },
  code: { type: String, default: null },
  batchNo: { type: String, default: null },
  category: { type: String, default: null },
  unit: { type: String, default: null },
  expected: { type: Number, default: 0 },
  counted: { type: Number, default: null },
  unitCost: { type: Number, default: 0 },
  note: { type: String, default: '' },
  countedByName: { type: String, default: null },
  countedAt: { type: Date, default: null },
  /** Set at reconcile: the shelf figure the adjustment was made against. */
  shelfAtReconcile: { type: Number, default: null },
  applied: { type: Number, default: null },
}, { _id: true });

const stockCountSchema = new mongoose.Schema({
  ref: { type: String, required: true, unique: true },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
  branchName: { type: String, default: '' },
  title: { type: String, default: '' },
  scope: { category: { type: String, default: null }, vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', default: null }, search: { type: String, default: null } },
  status: { type: String, enum: ['open', 'submitted', 'reconciled', 'cancelled'], default: 'open', index: true },
  lines: { type: [lineSchema], default: [] },
  totals: {
    items: { type: Number, default: 0 },
    counted: { type: Number, default: 0 },
    varianceQty: { type: Number, default: 0 },
    varianceValue: { type: Number, default: 0 },
    shortQty: { type: Number, default: 0 },
    excessQty: { type: Number, default: 0 },
    stockValueBefore: { type: Number, default: 0 },
    stockValueAfter: { type: Number, default: null },
  },
  createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  createdByName: { type: String, default: null },
  submittedAt: { type: Date, default: null },
  submittedByName: { type: String, default: null },
  reconciledAt: { type: Date, default: null, index: true },
  reconciledById: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  reconciledByName: { type: String, default: null },
  cancelledAt: { type: Date, default: null },
  cancelReason: { type: String, default: null },
  notes: { type: String, default: '' },
}, { timestamps: true });

/** Recompute the sheet totals from its lines. */
stockCountSchema.methods.recalc = function () {
  const t = { items: this.lines.length, counted: 0, varianceQty: 0, varianceValue: 0, shortQty: 0, excessQty: 0, stockValueBefore: 0, stockValueAfter: this.totals?.stockValueAfter ?? null };
  for (const l of this.lines) {
    const cost = Number(l.unitCost) || 0;
    t.stockValueBefore += (Number(l.expected) || 0) * cost;
    if (l.counted === null || l.counted === undefined) continue;
    t.counted += 1;
    const v = (Number(l.counted) || 0) - (Number(l.expected) || 0);
    t.varianceQty += v;
    t.varianceValue += v * cost;
    if (v < 0) t.shortQty += -v; else if (v > 0) t.excessQty += v;
  }
  for (const k of ['varianceValue', 'stockValueBefore']) t[k] = Math.round(t[k] * 100) / 100;
  this.totals = t;
  return t;
};

module.exports = mongoose.model('StockCount', stockCountSchema);
