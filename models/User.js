const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const UserSchema = new mongoose.Schema({
  // Personal Information (from signup step 2)
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email']
  },
  fullName: {
    type: String,
    required: [true, 'Full name is required'],
    trim: true
  },
  phone: {
    type: String,
    required: [true, 'Phone number is required'],
    trim: true,
    match: [/^\d{10}$/, 'Please enter a valid 10-digit phone number']
  },
  
  // Location (from signup step 1)
  location: {
    type: String,
    required: [true, 'Location is required'],
    enum: ['Jubilee Hills', 'Financial District', 'Kondapur']
  },
  
  // Additional Details (from signup step 3)
  dateOfBirth: {
    type: String,
    required: [true, 'Date of birth is required']
  },
  gender: {
    type: String,
    required: [true, 'Gender is required'],
    enum: ['Male', 'Female', 'Other', 'Prefer not to say']
  },
  
  // Profile Picture
  profilePicture: {
    url: {
      type: String,
      default: null
    },
    publicId: {
      type: String,
      default: null
    }
  },
  
  // OTP for verification
  otp: {
    type: String,
    default: null
  },
  otpExpiry: {
    type: Date,
    default: null
  },
  
  // Account status
  isVerified: {
    type: Boolean,
    default: false
  },
  isActive: {
    type: Boolean,
    default: true
  },
  
  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now
  },
  lastLogin: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

// Index for faster queries
UserSchema.index({ email: 1 });
UserSchema.index({ phone: 1 });

// Method to generate OTP (4-digit)
UserSchema.methods.generateOTP = function() {
  const otp = Math.floor(1000 + Math.random() * 9000).toString();
  this.otp = otp;
  this.otpExpiry = Date.now() + 5 * 60 * 1000; // 5 minutes
  return otp;
};

// Method to verify OTP
UserSchema.methods.verifyOTP = function(enteredOTP) {
  if (!this.otp || !this.otpExpiry) {
    return false;
  }
  
  if (Date.now() > this.otpExpiry) {
    return false;
  }
  
  // Clean and compare OTPs (remove whitespace, ensure string comparison)
  const storedOTP = String(this.otp).trim();
  const inputOTP = String(enteredOTP).trim();
  
  return storedOTP === inputOTP;
};

// Method to clear OTP
UserSchema.methods.clearOTP = function() {
  this.otp = null;
  this.otpExpiry = null;
};

module.exports = mongoose.model('User', UserSchema);
