const mongoose = require('mongoose');

/**
 * Stock moved between centres — Zenoti's "Add transfer" in Procurement
 * (e.g. Financial District Pharmacy → Jubilee Hills Pharmacy, DELIVERED, 15).
 *
 * draft → sent (source shelf decremented, ledger `transfer_out`) → received
 * (destination row found or created, ledger `transfer_in`). Cancelling a sent
 * transfer puts the units back on the source shelf. A transfer return is just
 * a transfer the other way.
 */
const lineSchema = new mongoose.Schema({
  inventoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Inventory', required: true },
  toInventoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Inventory', default: null },
  name: { type: String, default: '' },
  code: { type: String, default: null },
  batchNo: { type: String, default: null },
  expiryDate: { type: Date, default: null },
  qty: { type: Number, required: true, min: 1 },
  receivedQty: { type: Number, default: null },
  unitCost: { type: Number, default: 0 },
  note: { type: String, default: '' },
}, { _id: true });

const stockTransferSchema = new mongoose.Schema({
  ref: { type: String, required: true, unique: true },
  kind: { type: String, enum: ['transfer', 'return'], default: 'transfer' },
  fromBranchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  fromBranchName: { type: String, default: '' },
  toBranchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, index: true },
  toBranchName: { type: String, default: '' },
  status: { type: String, enum: ['draft', 'sent', 'received', 'cancelled'], default: 'draft', index: true },
  lines: { type: [lineSchema], default: [] },
  totals: { qty: { type: Number, default: 0 }, value: { type: Number, default: 0 } },
  notes: { type: String, default: '' },
  createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  createdByName: { type: String, default: null },
  sentAt: { type: Date, default: null },
  sentByName: { type: String, default: null },
  receivedAt: { type: Date, default: null },
  receivedByName: { type: String, default: null },
  cancelledAt: { type: Date, default: null },
  cancelReason: { type: String, default: null },
}, { timestamps: true });

stockTransferSchema.methods.recalc = function () {
  const t = { qty: 0, value: 0 };
  for (const l of this.lines) { t.qty += Number(l.qty) || 0; t.value += (Number(l.qty) || 0) * (Number(l.unitCost) || 0); }
  t.value = Math.round(t.value * 100) / 100;
  this.totals = t;
  return t;
};

module.exports = mongoose.model('StockTransfer', stockTransferSchema);
