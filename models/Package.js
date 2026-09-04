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
    sessions: { type: Number, default: 1, min: 1 }
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
  /** Zenoti's series terms (validity, schedule, freeze count, T&Cs), stored raw. */
  zenotiSeriesTerms: { type: mongoose.Schema.Types.Mixed, default: null }
}, {
  timestamps: true
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
