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
  /*
   * The MRP: the one price a product has, final, every tax included (store
   * policy, 2026-09-28). It is what the panel enters, what the app shows and
   * what checkout charges — nothing is added on top. There is no separate
   * selling or buying price any more; `mrp` below is kept equal to this.
   */
  price: {
    type: Number,
    required: [true, 'Product MRP is required'],
    min: [0, 'MRP cannot be negative']
  },
  /*
   * The GST rate the MRP already includes. Information only: checkout never
   * adds it (utils/orderPricing), the app never shows it, and a desk bill
   * uses it to split the tax out of the MRP for the receipt. 18 unless the
   * panel says otherwise.
   */
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
  /*
   * Stock on hand. A product nobody has counted yet starts at the default
   * opening stock (utils/productStock.DEFAULT_OPENING_STOCK), so it is on
   * sale the moment it is listed; the panel sets the real figure. The app is
   * told whether a product is in stock, never how many are left.
   */
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
  /**
   * Which centres list this product, straight from Zenoti's per-centre product
   * feed. The pharmacy centres carry the retail range; a clinic carries what
   * its treatment rooms and desk sell. Availability, not stock.
   */
  centres: [{
    _id: false,
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
    zenotiCenterId: { type: String, default: null, trim: true },
    branchName: { type: String, default: '', trim: true },
  }],
  /**
   * Centre-wise listing, set in the admin panel (utils/productCentre.js).
   *
   * One row per CLINIC centre: whether guests shopping at that centre see the
   * product, what it costs there (null = the base `price`), and whether it can
   * be collected there. A centre with no row gets the defaults — visible, base
   * price, collectable — so untouched products behave as they always did.
   * `centres` above is Zenoti's stock feed and is never consulted for this.
   */
  centreListings: [{
    _id: false,
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    branchName: { type: String, default: '', trim: true },
    visible: { type: Boolean, default: true },
    price: { type: Number, default: null, min: 0 },
    pickup: { type: Boolean, default: true },
  }],
  barcodes: { type: [String], default: [] },
  isKit: { type: Boolean, default: false },
  zenotiCategoryId: { type: String, default: null, trim: true },
  zenotiSubCategoryId: { type: String, default: null, trim: true },
  /*
   * Commerce catalogue flag (2026-09-06). Zenoti's product master holds ~674
   * items; the app sells a curated subset — the OTC list the pharmacy signed
   * off. Only rows with isAppProduct true appear under Commerce › Products and
   * in the app. The Zenoti sync creates new master rows with this false and
   * never flips it; the App Stock template import and the panel do.
   */
  isAppProduct: { type: Boolean, default: false, index: true },
  /* ---- App Stock template fields (JH retail import / export sheet) ---- */
  batchTracking: { type: String, enum: ['Batchable', 'Non Batchable', null], default: null },
  consumptionOrder: { type: String, enum: ['FIFO', 'ByExpiry', null], default: null },
  reorderLevel: { type: Number, default: null, min: 0 },
  targetLevel: { type: Number, default: null, min: 0 },
  packName: { type: String, default: null, trim: true },
  /**
   * Retired 2026-09-28: a product carries its MRP only. Nothing reads, edits,
   * imports or exports this any more; the field stays so the few rows that
   * held a purchase cost keep it on record.
   */
  buyingPrice: { type: Number, default: null, min: 0 },
  vendorName: { type: String, default: null, trim: true },
  /** Sheet status: 'VPA confirmed' | 'estimated' | 'needs price' — how sure the MRP is. */
  templateStatus: { type: String, default: null, trim: true },
  /** Where `stock` last came from: 'template' import, 'panel' edit, or 'order' movement. */
  stockSource: { type: String, default: null },
  stockUpdatedAt: { type: Date, default: null },
  /**
   * Always equal to `price`, which IS the MRP (the pre-validate hook below
   * keeps the two together). Kept because the desk bill, the bulk sheet and
   * app builds already installed read it; a writer that sets only `mrp`
   * moves `price` with it.
   */
  mrp: { type: Number, default: null },
  /** Where the MRP (`price`) came from: Zenoti, the panel, or a template import. */
  priceSource: { type: String, enum: ['zenoti-mrp', 'panel', 'template', null], default: null },
  /** Pack size as Zenoti records it, e.g. "1 ML", "30 GM". */
  packSize: { type: String, default: null, trim: true },
  hsn: { type: String, default: null, trim: true },
  productSubCategory: { type: String, default: null, trim: true },
  /** Zenoti's split: retail (sold to guests) vs consumable (used in treatment). */
  isRetail: { type: Boolean, default: null },
  /**
   * Prescription-only (Rx) vs over-the-counter (OTC).
   *
   * Schedule H medicines (minoxidil, isotretinoin, topical steroids,
   * antibiotics, hydroquinone…) may only be dispensed against a signed
   * prescription. The app shows an Rx product with its description but does
   * not sell it unless the guest holds a matching prescription; the desk sees
   * the flag on the product card. `null` = not yet classified.
   *
   * `rxSource` records who decided: the panel ('manual'), the bulk import
   * ('import'), or the classifier in utils/rxClassifier.js ('heuristic').
   * A manual decision is never overwritten by the heuristic.
   */
  isRx: { type: Boolean, default: null, index: true },
  rxSource: { type: String, enum: ['manual', 'import', 'heuristic', null], default: null },
  rxReason: { type: String, default: null, trim: true },
  /** Preferred supplier. Optional; purchase orders may name any vendor. */
  vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', default: null, index: true },
  /**
   * Whether `stock` means anything for this product.
   *
   * Zenoti's API exposes no stock figure (verified 2026-09-04), so a product
   * mirrored from Zenoti has nothing to count. With trackStock false the store
   * neither blocks a sale on `stock` nor decrements it, and the availability
   * view reports "available" rather than "out of stock". Turn it on in the
   * panel once the clinic starts recording counts here (or a stock feed exists).
   */
  trackStock: { type: Boolean, default: true },
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

  // --- Shop taxonomy & product page (utils/productTaxonomy.js) --------------
  /** URL-safe name, unique when present. Stable across renames; used for links. */
  slug: { type: String, default: null, trim: true, lowercase: true },
  /**
   * Every photograph of the product, in the order the product page shows
   * them. `image` above is the main one and is always the first of these;
   * lists and the cart read `image` alone.
   */
  images: { type: [String], default: [] },
  /** One line for cards and search results. `description` stays the full text. */
  shortDescription: { type: String, default: '', trim: true },
  /**
   * Every category the product sits under. `productCategory` is the main one
   * and is always among them; a hair supplement is in both Hair Care and
   * Supplements and must be found under either.
   */
  categories: { type: [String], default: [] },
  /** Concern slugs — what the guest wants help with (acne, pigmentation…). */
  concerns: { type: [String], default: [] },
  /** Hand-picked shelves: 'bestseller' | 'new-arrival' | 'kids'. `isPopular` mirrors bestseller. */
  shopCollections: { type: [String], default: [] },
  /**
   * The long-form product page. Every part is optional; the app shows only
   * what is filled. Ingredient lists are as printed on the pack.
   */
  details: {
    overview: { type: String, default: '', trim: true },
    benefits: { type: [String], default: [] },
    keyIngredients: { type: [String], default: [] },
    ingredients: { type: String, default: '', trim: true },
    howToUse: { type: [String], default: [] },
    suitableFor: { type: String, default: '', trim: true },
    manufacturer: { type: String, default: '', trim: true },
    countryOfOrigin: { type: String, default: '', trim: true },
  },
  /** Which catalogue load created the row ('catalogue-2026-09'); null = made in the panel. */
  catalogueSource: { type: String, default: null, trim: true },
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
// Partial (string values only) rather than sparse: MongoDB refuses an index
// that is both, and a refused index means the uniqueness guard never exists.
productSchema.index(
  { zenotiProductId: 1 },
  { unique: true, partialFilterExpression: { zenotiProductId: { $type: 'string' } } },
);
productSchema.index({ 'branchStock.branchId': 1 });
productSchema.index({ 'centreListings.branchId': 1, 'centreListings.visible': 1 });
// The three ways into the shop. Multikey, one array per index.
productSchema.index({ categories: 1 });
productSchema.index({ concerns: 1 });
productSchema.index({ shopCollections: 1 });
productSchema.index({ productCategory: 1 });
productSchema.index(
  { slug: 1 },
  { unique: true, partialFilterExpression: { slug: { $type: 'string' } } },
);

/*
 * One price. `price` is the MRP and `mrp` mirrors it; whichever a writer
 * changed, the two agree afterwards. A writer that set only `mrp` (an older
 * sheet or panel build) moves `price` with it; anything else copies `price`.
 */
productSchema.pre('validate', function keepMrpAndPriceTogether(next) {
  const mrp = Number(this.mrp);
  const mrpOnly = this.isNew
    ? this.price === null || this.price === undefined
    : this.isModified('mrp') && !this.isModified('price');
  if (mrpOnly && Number.isFinite(mrp) && mrp > 0) this.price = mrp;
  else if (this.price !== null && this.price !== undefined && Number.isFinite(Number(this.price))) this.mrp = Number(this.price);
  next();
});

module.exports = mongoose.model('Product', productSchema);
