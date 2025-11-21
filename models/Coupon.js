const mongoose = require('mongoose');

const couponSchema = new mongoose.Schema({
  code: {
    type: String,
    required: [true, 'Coupon code is required'],
    trim: true,
    uppercase: true,
    unique: true
  },
  description: {
    type: String,
    trim: true
  },
  discountType: {
    type: String,
    required: [true, 'Discount type is required'],
    enum: ['percentage', 'fixed'],
    default: 'percentage'
  },
  discountValue: {
    type: Number,
    required: [true, 'Discount value is required'],
    min: [0, 'Discount value cannot be negative']
  },
  minOrderValue: {
    type: Number,
    default: 0,
    min: [0, 'Minimum order value cannot be negative']
  },
  maxDiscount: {
    type: Number,
    default: null,
    min: [0, 'Maximum discount cannot be negative']
  },
  usageLimit: {
    type: Number,
    default: null,
    min: [0, 'Usage limit cannot be negative']
  },
  usageCount: {
    type: Number,
    default: 0,
    min: [0, 'Usage count cannot be negative']
  },
  perUserLimit: {
    type: Number,
    default: null,
    min: [0, 'Per user limit cannot be negative']
  },
  validFrom: {
    type: Date,
    required: [true, 'Valid from date is required']
  },
  validUntil: {
    type: Date,
    required: [true, 'Valid until date is required']
  },
  applicableProducts: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product'
  }],
  applicableCategories: [{
    type: String
  }],
  isActive: {
    type: Boolean,
    default: true
  },
  isPublic: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Index for better query performance
couponSchema.index({ isActive: 1 });
couponSchema.index({ validFrom: 1, validUntil: 1 });

// Virtual to check if coupon is expired
couponSchema.virtual('isExpired').get(function() {
  return new Date() > this.validUntil;
});

// Virtual to check if coupon is valid
couponSchema.virtual('isValid').get(function() {
  const now = new Date();
  return this.isActive && 
         now >= this.validFrom && 
         now <= this.validUntil &&
         (this.usageLimit === null || this.usageCount < this.usageLimit);
});

module.exports = mongoose.model('Coupon', couponSchema);
