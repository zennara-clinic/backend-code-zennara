const mongoose = require('mongoose');

const consultationSchema = new mongoose.Schema({
  id: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  slug: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    index: true
  },
  /**
   * Level 1 — ServiceType.name ("Skin", "Hair", "Skin & Hair", …).
   *
   * Optional so the pre-taxonomy entries that are being retired still
   * validate; everything created from the clinic's service list carries one.
   */
  type: {
    type: String,
    default: null,
    trim: true,
    index: true
  },
  /**
   * Level 2 — the treatment category ("Laser Treatments", "Chemical Peels").
   *
   * This used to hold what was effectively a type (SKIN, HAIR, ANTI AGEING).
   * The 2026-08-07 restructure moved that meaning up into `type` and gave this
   * field the clinic's real category names.
   */
  category: {
    type: String,
    required: true,
    trim: true,
    index: true
  },
  summary: {
    type: String,
    required: true
  },
  about: {
    type: String,
    required: true
  },
  key_benefits: [{
    type: String
  }],
  ideal_for: [{
    type: String
  }],
  price: {
    type: Number,
    required: true,
    index: true
  },
  /**
   * How long the treatment takes, in minutes.
   *
   * The `formattedDuration` virtual below has always read this, but the field
   * itself was never declared — so under Mongoose's strict mode it could not
   * be stored and the virtual returned "NaN mins" for every service. Declaring
   * it makes the virtual work and gives the bulk import somewhere to put the
   * Duration column. Null means "not specified", which the UI already handles.
   */
  duration_minutes: {
    type: Number,
    default: null,
    min: 0,
  },
  cta_label: {
    type: String,
    default: 'Book Consultation'
  },
  tags: [{
    type: String,
    index: true
  }],
  faqs: [{
    q: String,
    a: String
  }],
  pre_care: [{
    type: String
  }],
  post_care: [{
    type: String
  }],
  image: {
    type: String,
    /**
     * Optional since the 2026-08-07 restructure.
     *
     * The clinic's service list has 61 sub-categories; only 22 arrived with a
     * photograph. Requiring one meant the taxonomy could not be loaded at all
     * until every image existed. Both clients already branch on an empty
     * value — the app card falls back to a branded sage panel, and the panel
     * flags the entry as needing a photo — so a blank is a known state rather
     * than a broken one.
     */
    default: ''
  },
  media: [{
    type: {
      type: String,
      enum: ['image', 'video'],
      required: true
    },
    url: {
      type: String,
      required: true
    },
    thumbnail: {
      type: String,
      default: ''
    },
    publicId: {
      type: String,
      default: ''
    }
  }],
  rating: {
    type: Number,
    default: null,
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
    default: true,
    index: true
  },

  /* ------------------------- Service master vs catalogue -------------------
   * Two different questions, deliberately two fields:
   *
   *   isActive   — is this row live at all (the clinic still performs it)?
   *   inCatalog  — should a customer SEE and buy it in the app?
   *
   * The master list is everything the clinic bills for: ~775 rows including
   * staff lines, per-doctor variants and one-off billing entries. None of that
   * belongs on a customer's phone. The catalogue is the curated subset the desk
   * has deliberately published, and the app reads ONLY that.
   * ------------------------------------------------------------------------ */
  inCatalog: {
    type: Boolean,
    default: false,
    index: true,
  },
  /** Who published it to the catalogue, and when — this is a storefront change. */
  catalogAddedAt: { type: Date, default: null },
  catalogAddedBy: { type: String, default: null, trim: true },

  /**
   * Superseded rows kept for history.
   *
   * 36,000+ bookings and 2,400 package sales point at services by id. Deleting
   * a replaced service would strand every one of them, so a re-import retires
   * the old row instead: archived rows never appear in the panel's service list
   * or the app, but every historical reference still resolves.
   */
  isArchived: { type: Boolean, default: false, index: true },
  archivedAt: { type: Date, default: null },
  archivedReason: { type: String, default: null, trim: true },

  /** The Zenoti service this treatment/consultation is booked as (chosen in the panel). */
  zenotiServiceId: { type: String, default: null, trim: true, lowercase: true },

  /* ---- Zenoti service-master columns (its own export format) ---- */
  /** Second level of the clinic's taxonomy, e.g. Category "Laser" → Sub "Spa". */
  subCategory: { type: String, default: null, trim: true, index: true },
  /** Zenoti's BusinessUnitName column. */
  businessUnit: { type: String, default: null, trim: true },
  /** Zenoti's ServiceType column ("None", "Addon"…). */
  serviceType: { type: String, default: null, trim: true },

  /* ---- Service master attributes (mirroring Zenoti's service record) ---- */
  /** Clinic-facing service code ("4DCLF"), from Zenoti or the panel. Not unique: Zenoti's codes repeat. */
  code: { type: String, default: null, trim: true, index: true },
  /** Buffer after the service before the room/doctor is free again. */
  recovery_minutes: { type: Number, default: 0, min: 0 },
  /** GST rate applied to this service; `price` is tax-inclusive when priceIncludesTax. */
  taxPercent: { type: Number, default: 5, min: 0, max: 100 },
  priceIncludesTax: { type: Boolean, default: true },
  /**
   * Per-centre price, as Zenoti holds it. Empty = `price` everywhere.
   * `available:false` removes the service from that centre's menu.
   */
  centrePrices: [{
    _id: false,
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true },
    price: { type: Number, default: null, min: 0 },
    taxPercent: { type: Number, default: null, min: 0, max: 100 },
    available: { type: Boolean, default: true },
  }],
  /** Dermatologist slugs who may perform it. Empty = any dermatologist at an allowed centre. */
  eligibleDoctorIds: [{ type: String, trim: true, lowercase: true }],
  /**
   * Prerequisites — Zenoti's "guest must have finished X within N days".
   *
   * `requiresConsultation`: null inherits the clinic default (a new guest's
   * first visit is a consultation, see utils/guestEligibility.js); true or
   * false overrides it for this service. `serviceIds` are Consultation ids
   * the guest must have completed within `withinDays` (0 = ever).
   */
  prerequisites: {
    requiresConsultation: { type: Boolean, default: null },
    serviceIds: [{ type: String, trim: true }],
    withinDays: { type: Number, default: 0, min: 0 },
    note: { type: String, default: '' },
  },
  /** Consumables expected per session, for stock planning (BOM). */
  consumables: [{
    _id: false,
    inventoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Inventory', default: null },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    name: { type: String, default: '' },
    quantity: { type: Number, default: 1, min: 0 },
    unit: { type: String, default: '' },
    autoConsume: { type: Boolean, default: false },
  }],
  /** Consultation ids that can be added on to this service at booking. */
  addOnIds: [{ type: String, trim: true }],
  /** Sold only inside a package or membership; not bookable on its own. */
  packageOnly: { type: Boolean, default: false },
  /** Per-service policy; null = clinic default (24 h window, no fee). */
  policy: {
    cancellationWindowHours: { type: Number, default: null, min: 0 },
    cancellationFee: { type: Number, default: null, min: 0 },
    noShowFee: { type: Number, default: null, min: 0 },
    depositAmount: { type: Number, default: null, min: 0 },
  },
  /** Zenoti's own "bookable online" flag, kept for the readiness report. */
  zenotiCanBook: { type: Boolean, default: null },
  showPriceInApp: {
    type: Boolean,
    default: false,
    index: true
  },
  // When true, booking this treatment in the app charges the price up front
  // (Razorpay). When false, the guest books directly and pays at the clinic.
  // Consultations (dermatologist flow) always charge and ignore this.
  chargeOnlineBooking: {
    type: Boolean,
    default: true
  },
  isPopular: {
    type: Boolean,
    default: false,
    index: true
  },
  /** Manual ordering within a category (lower first); ties fall back to newest. */
  displayOrder: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

// Index for text search
consultationSchema.index({ 
  name: 'text', 
  summary: 'text', 
  about: 'text',
  tags: 'text'
});

// Virtual for formatted price
consultationSchema.virtual('formattedPrice').get(function() {
  return `₹${this.price.toLocaleString('en-IN')}`;
});

/** Price and tax at one centre: the per-centre row when set, else the base price. */
consultationSchema.methods.priceAt = function(branchId) {
  const row = branchId ? (this.centrePrices || []).find((c) => String(c.branchId) === String(branchId)) : null;
  const price = row && row.price !== null && row.price !== undefined ? row.price : this.price;
  const taxPercent = row && row.taxPercent !== null && row.taxPercent !== undefined ? row.taxPercent : (this.taxPercent ?? 0);
  const inclusive = this.priceIncludesTax !== false;
  const base = inclusive ? +(price / (1 + taxPercent / 100)).toFixed(2) : price;
  const tax = +(base * taxPercent / 100).toFixed(2);
  return { price, taxPercent, priceIncludesTax: inclusive, base, tax, total: inclusive ? price : +(price + tax).toFixed(2), available: row ? row.available !== false : true };
};

// Virtual for formatted duration
consultationSchema.virtual('formattedDuration').get(function() {
  if (this.duration_minutes < 60) {
    return `${this.duration_minutes} mins`;
  }
  const hours = Math.floor(this.duration_minutes / 60);
  const mins = this.duration_minutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
});

module.exports = mongoose.model('Consultation', consultationSchema);
