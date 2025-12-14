const mongoose = require('mongoose');

const bannerSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true
  },
  image: {
    type: String,
    required: true
  },
  linkType: {
    type: String,
    enum: ['none', 'internal', 'external'],
    default: 'none'
  },
  internalScreen: {
    type: String,
    enum: ['', 'consultations', 'treatments', 'appointments', 'orders', 'profile', 'offers'],
    default: ''
  },
  externalUrl: {
    type: String,
    default: ''
  },
  order: {
    type: Number,
    default: 0
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

bannerSchema.index({ order: 1, isActive: 1 });

module.exports = mongoose.model('Banner', bannerSchema);
