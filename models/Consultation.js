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
    required: true
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
