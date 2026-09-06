const mongoose = require('mongoose');

/**
 * One row per change to a stock quantity — the ledger behind every
 * "why is this number what it is" question. Written by the consume endpoint
 * (therapist sessions), bulk adjustments and manual edits from the panel.
 */
const stockMovementSchema = new mongoose.Schema(
  {
    inventoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Inventory', required: true, index: true },
    inventoryName: { type: String, default: '' },
    batchNo: { type: String, default: '' },
    type: {
      type: String,
      enum: ['consume', 'wastage', 'receive', 'adjust', 'sale', 'return', 'transfer_out', 'transfer_in', 'count'],
      required: true,
      index: true,
    },
    /** Signed quantity: negative for consume/wastage/sale, positive for receive/return. */
    delta: { type: Number, required: true },
    before: { type: Number, default: 0 },
    after: { type: Number, default: 0 },
    reason: { type: String, default: '' },
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', default: null, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    adminEmail: { type: String, default: '' },
    /** Which audit / transfer produced this row (for the ledger's drill-down). */
    stockCountId: { type: mongoose.Schema.Types.ObjectId, ref: 'StockCount', default: null },
    stockTransferId: { type: mongoose.Schema.Types.ObjectId, ref: 'StockTransfer', default: null },
    /** Unit cost at the time, so the ledger can be valued later. */
    unitCost: { type: Number, default: null },
  },
  { timestamps: true }
);

stockMovementSchema.index({ createdAt: -1 });

module.exports = mongoose.model('StockMovement', stockMovementSchema);
