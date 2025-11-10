const mongoose = require('mongoose');

const addressSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  label: {
    type: String,
    required: true,
    trim: true,
    enum: ['Home', 'Work', 'Other']
  },
  fullName: {
    type: String,
    required: true,
    trim: true
  },
  phone: {
    type: String,
    required: true,
    trim: true
  },
  addressLine1: {
    type: String,
    required: true,
    trim: true
  },
  addressLine2: {
    type: String,
    trim: true
  },
  city: {
    type: String,
    required: true,
    trim: true
  },
  state: {
    type: String,
    required: true,
    trim: true
  },
  postalCode: {
    type: String,
    required: true,
    trim: true
  },
  country: {
    type: String,
    required: true,
    trim: true,
    default: 'India'
  },
  location: {
    type: {
      type: String,
      enum: ['Point']
    },
    coordinates: {
      type: [Number] // [longitude, latitude]
    }
  },
  isDefault: {
    type: Boolean,
    default: false
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Update timestamp on save
addressSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

// Index for geospatial queries (if location is provided)
addressSchema.index({ 'location.coordinates': '2dsphere' });

// Ensure only one default address per user
addressSchema.pre('save', async function(next) {
  try {
    if (this.isDefault) {
      // Use findOneAndUpdate with proper options to prevent race conditions
      await this.constructor.updateMany(
        { 
          userId: this.userId, 
          _id: { $ne: this._id },
          isDefault: true 
        },
        { 
          $set: { isDefault: false } 
        },
        { 
          new: false // Don't need to return the updated docs
        }
      );
    }
    next();
  } catch (error) {
    console.error('❌ Error in address pre-save hook:', error);
    next(error);
  }
});

const Address = mongoose.model('Address', addressSchema);

module.exports = Address;
