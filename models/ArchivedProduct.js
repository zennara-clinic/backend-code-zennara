const mongoose = require('mongoose');

/**
 * Products that were in the catalogue and no longer are.
 *
 * When the catalogue is replaced (scripts/replaceCatalogue.js) the old rows
 * are moved here whole, under their original ids, before `products` is
 * emptied. Two things depend on that:
 *
 *   • A clinic counter sale is mirrored from Zenoti only when its product can
 *     be named (services/zenotiAssignmentMirror.js). The clinic goes on
 *     selling what it always sold, whatever the app's catalogue now lists, so
 *     the mirror looks here when the live catalogue has no match — otherwise
 *     replacing the catalogue would silently stop recording those sales.
 *   • It is the way back: every field is kept, so a row can be restored.
 *
 * Nothing here is ever shown in the shop, sold, or sent to Zenoti.
 */
const archivedProductSchema = new mongoose.Schema({
  name: { type: String, trim: true },
  code: { type: String, default: null },
  sku: { type: String, default: null },
  zenotiProductId: { type: String, default: null },
  isRetail: { type: Boolean, default: null },
  image: { type: String, default: '' },
  price: { type: Number, default: 0 },
  /** Which replacement retired the row, e.g. 'catalogue-2026-09'. */
  archiveBatch: { type: String, default: null, index: true },
  archivedAt: { type: Date, default: Date.now },
}, {
  // The whole product document is kept, not just the fields named above.
  strict: false,
  collection: 'products_archive',
  timestamps: false,
});

archivedProductSchema.index({ zenotiProductId: 1 });

module.exports = mongoose.model('ArchivedProduct', archivedProductSchema);
