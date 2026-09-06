const mongoose = require('mongoose');

/**
 * One row per stock change on a Commerce product — the product's own ledger.
 *
 * Sources:
 *   template     opening quantity from the App Stock import (a reset, not a delta)
 *   panel        someone typed a new count on the product page (a reset)
 *   app-order    an app order reserved stock (−) or was cancelled/returned (+)
 *   zenoti-sale  a product line on a Zenoti invoice mirrored from the clinic (−)
 *
 * (source, refId, productId) is unique so a re-mirrored invoice or a retried
 * order can never move stock twice.
 */
const schema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
  source: { type: String, enum: ['template', 'panel', 'app-order', 'zenoti-sale', 'adjustment'], required: true },
  refId: { type: String, default: null },
  delta: { type: Number, required: true },
  before: { type: Number, default: null },
  after: { type: Number, default: null },
  note: { type: String, default: null },
  at: { type: Date, default: Date.now, index: true },
  by: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
}, { timestamps: false });

schema.index({ productId: 1, at: -1 });
schema.index({ source: 1, refId: 1, productId: 1 }, { unique: true, partialFilterExpression: { refId: { $type: 'string' } } });

module.exports = mongoose.models.ProductStockMovement || mongoose.model('ProductStockMovement', schema);
