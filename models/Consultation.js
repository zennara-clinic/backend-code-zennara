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
