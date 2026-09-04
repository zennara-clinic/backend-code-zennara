const mongoose = require('mongoose');

const categorySchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  slug: {
    type: String,
    unique: true,
    lowercase: true
  },
  /**
   * Level 1 of the taxonomy this category sits under, by ServiceType.name
   * (e.g. "Skin"). Stored as the name rather than an id so a category read
   * needs no populate — the same trade-off Doctor.availableCentres makes.
   */
  type: {
    type: String,
    default: null,
    trim: true,
    index: true
  },
  /** Order within its type, in the app and the panel. */
  displayOrder: {
    type: Number,
    default: 0
  },
  description: {
    type: String,
    default: ''
  },
  /** Zenoti category id, when this category mirrors one of Zenoti's 22. */
  zenotiCategoryId: { type: String, default: null, trim: true, lowercase: true, index: true },
  isActive: {
    type: Boolean,
    default: true
  },
  consultationCount: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

// Generate slug before saving
categorySchema.pre('save', function(next) {
  if (this.isModified('name') || !this.slug) {
    this.slug = this.name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, '') // Remove special characters
      .replace(/\s+/g, '-') // Replace spaces with hyphens
      .replace(/-+/g, '-') // Replace multiple hyphens with single
      .replace(/^-+|-+$/g, ''); // Trim hyphens from start/end
  }
  next();
});

module.exports = mongoose.model('Category', categorySchema);
