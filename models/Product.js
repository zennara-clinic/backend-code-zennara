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
    enum: [
      'Serum', 'Hydrafacial Consumable', 'Cream', 'Facial Treatment', 
      'Face Wash', 'Lipbalm', 'Sunscreen Stick', 'Sunscreen', 
      'Moisturizer', 'Sachets', 'Anti Aging', 'Pigmentation', 
      'Injection', 'Shampoo'
    ]
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
  }
}, {
  timestamps: true
});

// Indexes for better query performance
productSchema.index({ formulation: 1 });
productSchema.index({ name: 'text', description: 'text', OrgName: 'text' });
productSchema.index({ isActive: 1 });

module.exports = mongoose.model('Product', productSchema);
