const mongoose = require('mongoose');

const vendorSchema = new mongoose.Schema({
  /** Zenoti's vendor id and code, for the mirror. */
  zenotiVendorId: { type: String, default: null, trim: true, lowercase: true, index: true },
  code: { type: String, default: null, trim: true },
  zenotiSyncedAt: { type: Date, default: null },
  name: {
    type: String,
    required: [true, 'Vendor name is required'],
    trim: true
  },
  contactPerson: {
    type: String,
    required: [true, 'Contact person is required'],
    trim: true
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    lowercase: true,
    trim: true,
    match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email']
  },
  phone: {
    type: String,
    required: [true, 'Phone number is required'],
    trim: true
  },
  address: {
    type: String,
    required: [true, 'Address is required'],
    trim: true
  },
  city: {
    type: String,
    trim: true
  },
  state: {
    type: String,
    trim: true
  },
  pincode: {
    type: String,
    trim: true
  },
  gstNumber: {
    type: String,
    trim: true,
    uppercase: true
  },
  panNumber: {
    type: String,
    trim: true,
    uppercase: true
  },
  bankDetails: {
    accountNumber: String,
    ifscCode: String,
    bankName: String,
    accountHolderName: String
  },
  status: {
    type: String,
    enum: ['Active', 'Inactive'],
    default: 'Active'
  },
  rating: {
    type: Number,
    min: 0,
    max: 5,
    default: 0
  },
  notes: {
    type: String,
    trim: true
  }
}, {
  timestamps: true
});

// Index for faster searches
vendorSchema.index({ name: 1, email: 1 });
vendorSchema.index({ status: 1 });

// Virtual for products supplied (will be calculated from inventory)
// `Product.vendorId` is the link (there was never a `Product.vendor` field, so
// this count read 0 for every vendor until 2026-09-06).
vendorSchema.virtual('productsSupplied', {
  ref: 'Product',
  localField: '_id',
  foreignField: 'vendorId',
  count: true
});

module.exports = mongoose.model('Vendor', vendorSchema);
