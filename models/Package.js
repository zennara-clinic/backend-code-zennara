const mongoose = require('mongoose');

const packageSchema = new mongoose.Schema({
  id: {
    type: String,
    unique: true,
    required: true
  },
  name: {
    type: String,
    required: [true, 'Package name is required'],
    trim: true
  },
  description: {
    type: String,
    required: [true, 'Package description is required'],
    trim: true
  },
  benefits: [{
    type: String,
    trim: true
  }],
  services: [{
    serviceId: {
      type: String,
      required: true
    },
    serviceName: String,
    servicePrice: Number,
    customPrice: Number,  // Optional custom price for this service in the package
    /** How many sittings of this treatment the package includes. */
    sessions: { type: Number, default: 1, min: 1 },
    /** Zenoti's "Order": which benefit a redemption draws from first when a bill could match several. */
    redemptionOrder: { type: Number, default: 1, min: 1 }
  }],
  /** Products redeemed like services (Zenoti "Products" benefit) and products handed over at sale ("Bundled Products"). */
  productBenefits: [{
    _id: false,
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    name: { type: String, default: '' },
    qty: { type: Number, default: 1, min: 1 },
  }],
  bundledProducts: [{
    _id: false,
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    name: { type: String, default: '' },
    qty: { type: Number, default: 1, min: 1 },
  }],
  consultationServices: [{
    serviceId: {
      type: String,
      required: true
    },
    serviceName: String,
    servicePrice: Number,
    customPrice: Number  // Optional custom price for this consultation in the package
  }],
  price: {
    type: Number,
    required: [true, 'Package price is required'],
    min: 0
  },
  originalPrice: {
    type: Number,
    default: 0
  },
  discount: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },
  image: {
    type: String,
    default: ''
  },
  media: [{
    url: String,
    type: {
      type: String,
      enum: ['image', 'video']
    },
    publicId: String
  }],
  isActive: {
    type: Boolean,
    default: true
  },
  isPopular: {
    type: Boolean,
    default: false
  },
  bookingsCount: {
    type: Number,
    default: 0
  },
  /** The Zenoti series package sold when this package is assigned (chosen in the panel). */
  zenotiPackageId: { type: String, default: null, trim: true, lowercase: true },

  /**
   * How long a customer has to use the package once it is assigned, in
   * months. Copied onto each assignment as `validUntil` at assignment time
   * (the panel may override the date per customer), after which the sessions
   * can no longer be booked and the assignment is marked Expired nightly.
   * 12 = one year, 6 = six months.
   */
  validityMonths: { type: Number, default: 12, min: 1, max: 60 },
  /** GST on the package when sold at the desk; `price` is the tax-inclusive figure the app shows. */
  taxPercent: { type: Number, default: 5, min: 0 },
  priceIncludesTax: { type: Boolean, default: true },

  /* ---- Zenoti "Create package" fields (2026-09-06) ---- */
  /** Short code printed on receipts and used in searches (Zenoti Code*, e.g. 2GFCEXO). */
  code: { type: String, default: null, trim: true, uppercase: true },
  category: { type: String, default: 'Default', trim: true },
  /**
   * Zenoti's package kinds. `series` is the normal multi-session package,
   * `day` a day package, `offer` a promotional bundle, and `custom` one built
   * for a single guest at the desk (it never appears in the catalogue).
   */
  packageType: { type: String, enum: ['series', 'custom', 'day', 'offer'], default: 'series' },
  /** Where the row came from: Zenoti's catalogue / a Zenoti sale, or built here. */
  origin: { type: String, enum: ['zenoti', 'panel'], default: 'panel', index: true },
  /**
   * True while the package is still listed by a Zenoti centre. A package sold
   * to a guest and later retired (or built custom at the desk) stays in the
   * system for its assignments but is not part of the sellable catalogue.
   */
  inCatalogue: { type: Boolean, default: false, index: true },
  /** Centres that list this package, from Zenoti's per-centre feed. */
  centres: [{
    _id: false,
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
    zenotiCenterId: { type: String, default: null, trim: true },
    branchName: { type: String, default: '', trim: true },
  }],
  zenotiCategoryId: { type: String, default: null, trim: true },
  /** Zenoti exposes no package line items; true once someone fills them in. */
  contentsKnown: { type: Boolean, default: false },
  /**
   * Validity. `validityMonths` above stays the app's simple figure; these refine it:
   * neverExpires wins, else validityDays when set, else validityMonths. Validity
   * starts at the sale or at the first redemption; graceDays allow redemption
   * after expiry.
   */
  neverExpires: { type: Boolean, default: false },
  validityDays: { type: Number, default: null, min: 1 },
  validityStartsAt: { type: String, enum: ['sale', 'firstRedemption'], default: 'sale' },
  graceDays: { type: Number, default: 0, min: 0 },
  /** Mark the assignment Completed when every benefit is used (Zenoti default is No; ours has always been Yes). */
  closeWhenConsumed: { type: Boolean, default: true },
  /** Where the sessions may be redeemed. */
  redemption: {
    scope: { type: String, enum: ['organization', 'centres'], default: 'organization' },
    branchIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  },
  /** Where it is sold and at what price (blank = the base price everywhere). */
  centrePrices: [{
    _id: false,
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    price: { type: Number, default: null },
    taxPercent: { type: Number, default: null },
    available: { type: Boolean, default: true },
  }],
  /** Freeze allowance per assignment (0 = no freezing). */
  maxFreezes: { type: Number, default: 2, min: 0 },
  maxFreezeDays: { type: Number, default: 90, min: 0 },
  /** Instalments: the smallest share of the price that earns a receipt (0 = pay in full). */
  minPartialPaymentPercent: { type: Number, default: 0, min: 0, max: 100 },
  agreementText: { type: String, default: '', trim: true },
  /** Bumped whenever benefits or price change; assignments snapshot the version they were sold on. */
  version: { type: Number, default: 1 },
  versions: [{
    _id: false,
    version: Number,
    at: Date,
    by: String,
    price: Number,
    services: mongoose.Schema.Types.Mixed,
    validityMonths: Number,
    validityDays: Number,
    neverExpires: Boolean,
    graceDays: Number,
  }],
  /** Zenoti's series terms (validity, schedule, freeze count, T&Cs), stored raw. */
  zenotiSeriesTerms: { type: mongoose.Schema.Types.Mixed, default: null }
}, {
  timestamps: true
});

packageSchema.index({ code: 1 }, { unique: true, sparse: true });

/** Sale price at a centre, with tax split (mirrors Consultation.priceAt). */
packageSchema.methods.priceAt = function(branchId) {
  const row = branchId ? (this.centrePrices || []).find((c) => String(c.branchId) === String(branchId)) : null;
  const price = row && row.price !== null && row.price !== undefined ? row.price : this.price;
  const taxPercent = row && row.taxPercent !== null && row.taxPercent !== undefined ? row.taxPercent : (this.taxPercent ?? 5);
  const inclusive = this.priceIncludesTax !== false;
  const base = inclusive ? +(price / (1 + taxPercent / 100)).toFixed(2) : price;
  const tax = +(base * taxPercent / 100).toFixed(2);
  return { price, taxPercent, priceIncludesTax: inclusive, base, tax, total: inclusive ? price : +(price + tax).toFixed(2), available: row ? row.available !== false : true };
};

/** Days of validity from the sale/first redemption; null = never expires. */
packageSchema.methods.validityInDays = function() {
  if (this.neverExpires) return null;
  if (Number(this.validityDays) > 0) return Number(this.validityDays);
  const months = Number(this.validityMonths) > 0 ? Number(this.validityMonths) : 12;
  return Math.round(months * 30.4375);
};

/** Terms a new assignment copies (so later edits to the package never move the goalposts). */
packageSchema.methods.termsSnapshot = function() {
  return {
    version: this.version || 1, code: this.code || null,
    validityDays: this.validityInDays(), neverExpires: !!this.neverExpires, validityStartsAt: this.validityStartsAt || 'sale',
    graceDays: Number(this.graceDays) || 0, closeWhenConsumed: this.closeWhenConsumed !== false,
    redeemableScope: this.redemption?.scope || 'organization', redeemableBranchIds: (this.redemption?.branchIds || []).map(String),
    maxFreezes: Number(this.maxFreezes) || 0, maxFreezeDays: Number(this.maxFreezeDays) || 0,
    minPartialPaymentPercent: Number(this.minPartialPaymentPercent) || 0,
  };
};

// Version bump: benefits or price changed on an existing package.
packageSchema.pre('save', function(next) {
  if (!this.isNew && (this.isModified('services') || this.isModified('price') || this.isModified('validityMonths') || this.isModified('validityDays') || this.isModified('neverExpires') || this.isModified('graceDays') || this.isModified('productBenefits'))) {
    const prev = this.$locals?.previousVersionSnapshot;
    this.versions = [...(this.versions || []).slice(-19), {
      version: this.version || 1, at: new Date(), by: this.$locals?.changedBy || null,
      price: prev?.price ?? this.price, services: prev?.services ?? this.services, validityMonths: prev?.validityMonths ?? this.validityMonths,
      validityDays: prev?.validityDays ?? this.validityDays, neverExpires: prev?.neverExpires ?? this.neverExpires, graceDays: prev?.graceDays ?? this.graceDays,
    }];
    this.version = (this.version || 1) + 1;
  }
  next();
});

// Calculate original price before saving
packageSchema.pre('save', function(next) {
  if (this.services && this.services.length > 0) {
    this.originalPrice = this.services.reduce((total, service) => {
      // Use customPrice if available, otherwise use servicePrice — per session.
      const unit = service.customPrice !== undefined && service.customPrice !== null ? service.customPrice : (service.servicePrice || 0);
      return total + unit * (service.sessions || 1);
    }, 0);
    
    // Add consultation services to original price
    if (this.consultationServices && this.consultationServices.length > 0) {
      this.originalPrice += this.consultationServices.reduce((total, service) => {
        // Use customPrice if available, otherwise use servicePrice
        return total + (service.customPrice !== undefined ? service.customPrice : (service.servicePrice || 0));
      }, 0);
    }
    
    // Calculate discount percentage
    if (this.price < this.originalPrice) {
      this.discount = Math.round(((this.originalPrice - this.price) / this.originalPrice) * 100);
    }
  }
  next();
});

const Package = mongoose.model('Package', packageSchema);

module.exports = Package;
