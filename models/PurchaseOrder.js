const mongoose = require('mongoose');

/**
 * A purchase order — the inbound half of stock control.
 *
 * Until now stock only ever moved through `consume`, `wastage`, `adjust`,
 * `sale` and `return`. Nothing recorded how it arrived, so "what did we buy
 * from this vendor", "what is still owed to us" and "why did this number go
 * up" had no answer beyond a manual adjustment with a free-text reason.
 *
 * The flow is deliberately explicit:
 *
 *   draft → raised → approved → ordered → partially_received
 *                                       → fully_received
 *   (cancelled from any state before goods arrive)
 *
 * Receipts are the ONLY thing that increases branch stock on this path, and a
 * receipt is recorded per line, not per order, because a vendor part-ships.
 * Every receipt also writes a StockMovement row, so the ledger remains the
 * single explanation for any quantity.
 */

const receiptSchema = new mongoose.Schema(
  {
    quantity: { type: Number, required: true, min: 0 },
    /** Arrived broken / expired / wrong item — received but NOT added to stock. */
    rejectedQuantity: { type: Number, default: 0, min: 0 },
    rejectionReason: { type: String, default: '', trim: true },
    batchNo: { type: String, default: '', trim: true },
    expiryDate: { type: Date, default: null },
    receivedAt: { type: Date, default: Date.now },
    receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    receivedByName: { type: String, default: '', trim: true },
    note: { type: String, default: '', trim: true },
  },
  { _id: false },
);

const lineSchema = new mongoose.Schema(
  {
    /** Retail product, clinic consumable, or neither (free text for a one-off). */
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    inventoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Inventory', default: null },
    /** Snapshot, so the order still reads correctly if the item is renamed. */
    name: { type: String, required: true, trim: true },
    sku: { type: String, default: '', trim: true },

    requestedQuantity: { type: Number, required: true, min: 0 },
    /**
     * Sum of the receipts below, maintained by the model rather than written
     * by a caller — two people receiving the same delivery must not be able to
     * disagree with the receipt history.
     */
    receivedQuantity: { type: Number, default: 0, min: 0 },
    rejectedQuantity: { type: Number, default: 0, min: 0 },

    /** Agreed unit cost. Procurement-only; never exposed to a doctor. */
    unitCost: { type: Number, default: 0, min: 0 },
    taxPercent: { type: Number, default: 0, min: 0, max: 100 },

    receipts: { type: [receiptSchema], default: [] },
    note: { type: String, default: '', trim: true },
  },
  { _id: true },
);

/** Outstanding on a line. Never negative — an over-delivery is not a debt. */
lineSchema.virtual('pendingQuantity').get(function () {
  return Math.max(0, (this.requestedQuantity || 0) - (this.receivedQuantity || 0));
});

const purchaseOrderSchema = new mongoose.Schema(
  {
    /** Human reference, e.g. PO-2609-0007. Unique and never reused. */
    poNumber: { type: String, required: true, unique: true, index: true },

    vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },
    vendorName: { type: String, default: '', trim: true },

    /** Stock is received INTO a branch, so this is required from `raised` on. */
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    branchName: { type: String, default: '', trim: true },

    lines: { type: [lineSchema], default: [] },

    status: {
      type: String,
      enum: ['draft', 'raised', 'approved', 'ordered', 'partially_received', 'fully_received', 'cancelled'],
      default: 'draft',
      index: true,
    },
    /** Every status change, with who and when. */
    statusHistory: [{
      _id: false,
      status: String,
      at: { type: Date, default: Date.now },
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
      byName: String,
      note: String,
    }],

    raisedAt: { type: Date, default: null },
    expectedDeliveryDate: { type: Date, default: null },
    /** First delivery. `fullyReceivedAt` is the last one. */
    receivedAt: { type: Date, default: null },
    fullyReceivedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },

    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    approvedByName: { type: String, default: '', trim: true },
    approvedAt: { type: Date, default: null },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    createdByName: { type: String, default: '', trim: true },

    notes: { type: String, default: '', trim: true, maxlength: 2000 },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } },
);

/** Order totals, derived so they can never disagree with the lines. */
purchaseOrderSchema.virtual('totals').get(function () {
  const lines = this.lines || [];
  const requested = lines.reduce((n, l) => n + (l.requestedQuantity || 0), 0);
  const received = lines.reduce((n, l) => n + (l.receivedQuantity || 0), 0);
  const rejected = lines.reduce((n, l) => n + (l.rejectedQuantity || 0), 0);
  const value = lines.reduce((n, l) => {
    const net = (l.requestedQuantity || 0) * (l.unitCost || 0);
    return n + net + (net * (l.taxPercent || 0)) / 100;
  }, 0);
  return {
    requested,
    received,
    rejected,
    pending: Math.max(0, requested - received),
    estimatedValue: Math.round(value),
  };
});

/**
 * Keep the per-line receipt totals and the order status honest.
 *
 * Both are DERIVED here rather than set by callers: a receipt endpoint that
 * also had to remember to update three counters and a status is a bug waiting
 * to happen, and the numbers would drift the first time one path forgot.
 */
purchaseOrderSchema.pre('save', function (next) {
  for (const line of this.lines || []) {
    line.receivedQuantity = (line.receipts || []).reduce((n, r) => n + (r.quantity || 0), 0);
    line.rejectedQuantity = (line.receipts || []).reduce((n, r) => n + (r.rejectedQuantity || 0), 0);
  }

  // Only orders that are actually out with a vendor auto-advance on receipt.
  // A draft or a cancelled order must never be moved by a stray receipt.
  const receivable = ['approved', 'ordered', 'partially_received', 'fully_received'];
  if (receivable.includes(this.status)) {
    const lines = this.lines || [];
    const anyReceived = lines.some((l) => (l.receivedQuantity || 0) > 0);
    const allComplete = lines.length > 0
      && lines.every((l) => (l.receivedQuantity || 0) >= (l.requestedQuantity || 0));
    if (allComplete) {
      this.status = 'fully_received';
      this.fullyReceivedAt = this.fullyReceivedAt || new Date();
    } else if (anyReceived) {
      this.status = 'partially_received';
    }
    if (anyReceived && !this.receivedAt) this.receivedAt = new Date();
  }
  next();
});

purchaseOrderSchema.index({ vendorId: 1, createdAt: -1 });
purchaseOrderSchema.index({ branchId: 1, status: 1 });
// Product-wise purchase history reads off this one.
purchaseOrderSchema.index({ 'lines.productId': 1, createdAt: -1 });
purchaseOrderSchema.index({ 'lines.inventoryId': 1, createdAt: -1 });
purchaseOrderSchema.index({ createdAt: -1 });

module.exports = mongoose.model('PurchaseOrder', purchaseOrderSchema);
