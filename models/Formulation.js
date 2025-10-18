const mongoose = require('mongoose');

const formulationSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Formulation name is required'],
    trim: true,
    unique: true
  },
  description: {
    type: String,
    trim: true
  },
  isActive: {
    type: Boolean,
    default: true
  },
  productsCount: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

// Index for better query performance
formulationSchema.index({ name: 'text', description: 'text' });
formulationSchema.index({ isActive: 1 });

module.exports = mongoose.model('Formulation', formulationSchema);
