const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Product name is required'],
    trim: true
  },
  description: {
    type: String,
    required: [true, 'Product description is required']
  },
  formulation: {
    type: String,
    required: [true, 'Product formulation is required'],
    // Free text, validated against the Formulation collection at write time
    // (see adminProductController). A fixed enum here meant a formulation the
    // panel created could never be used on a product.
    trim: true
  },
  OrgName: {
    type: String,
    required: [true, 'Organization name is required'],
    trim: true
  },
  code: {
    type: String,
    trim: true,
    sparse: true,
    unique: true
  },
  price: {
    type: Number,
    required: [true, 'Product price is required'],
    min: [0, 'Price cannot be negative']
  },
  gstPercentage: {
    type: Number,
    required: [true, 'GST percentage is required'],
    min: [0, 'GST percentage cannot be negative'],
    max: [100, 'GST percentage cannot exceed 100'],
    default: 18
  },
  image: {
    type: String,
    default: ''
    // Not required to allow products without images
  },
  stock: {
    type: Number,
    required: true,
    default: 0,
    min: [0, 'Stock cannot be negative']
  },
  rating: {
    type: Number,
    default: 0,
    min: 0,
    max: 5
  },
  reviews: {
    type: Number,
    default: 0,
    min: 0
  },
  isActive: {
    type: Boolean,
    default: true
  },
  isPopular: {
    type: Boolean,
    default: false
  },

  // --- Zenoti catalogue linkage & clinical attributes ---------------------
  // Zenoti is the system of record for the retail catalogue and its stock.
  // These fields are written by the product importer (services/zenotiProduct
  // SyncService.js) and are what the doctor-facing availability view reads.
  // `code` above is the SKU as far as the store is concerned; `sku` is kept
  // separate because Zenoti's SKU and our own product code are not always the
  // same string and `code` carries a unique index we must not fight.

  /** Zenoti's product id. Unique when present; absent for app-only products. */
  zenotiProductId: {
    type: String,
    default: null,
    trim: true,
  },
  /** Zenoti SKU / short code, shown to dermatologists so they can name the item. */
  sku: {
    type: String,
    default: null,
    trim: true,
  },
  /** Brand as Zenoti records it. `OrgName` remains the legacy display field. */
  brand: {
    type: String,
    default: null,
    trim: true,
  },
  /** Retail vs consumable etc., mirroring Zenoti's product type. */
  productType: {
    type: String,
    default: null,
    trim: true,
  },
  /** Free-text category from Zenoti; the app's own taxonomy stays separate. */
  productCategory: {
    type: String,
    default: null,
    trim: true,
  },
  /**
   * Per-branch quantity, so "is it in stock at Jubilee Hills?" can be answered
   * without a Zenoti round-trip. `stock` above stays the app-store total.
   */
  branchStock: [{
    _id: false,
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
    zenotiCenterId: { type: String, default: null, trim: true },
    branchName: { type: String, default: '', trim: true },
    quantity: { type: Number, default: 0, min: 0 },
  }],
  /** Below this, the availability view reports "low stock" rather than "in stock". */
  lowStockThreshold: {
    type: Number,
    default: 5,
    min: 0,
  },
  /** Last successful Zenoti product sync; null = never synced (local product). */
  zenotiSyncedAt: {
    type: Date,
    default: null,
  },
}, {
  timestamps: true
});

// Indexes for better query performance
productSchema.index({ formulation: 1 });
productSchema.index({ name: 'text', description: 'text', OrgName: 'text' });
productSchema.index({ isActive: 1 });
productSchema.index({ sku: 1 });
// Sparse + unique: many products have no Zenoti id, but a Zenoti id may never
// map to two products or the importer would fork the catalogue.
productSchema.index(
  { zenotiProductId: 1 },
  { unique: true, sparse: true, partialFilterExpression: { zenotiProductId: { $type: 'string' } } },
);
productSchema.index({ 'branchStock.branchId': 1 });

module.exports = mongoose.model('Product', productSchema);
