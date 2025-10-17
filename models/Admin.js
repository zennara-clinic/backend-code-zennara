const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const AdminSchema = new mongoose.Schema({
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email']
  },
  name: {
    type: String,
    default: function() {
      return this.email.split('@')[0];
    }
  },
  role: {
    type: String,
    enum: ['super_admin', 'admin', 'doctor', 'receptionist'],
    default: 'admin'
  },
  
  // OTP for verification (hashed for security)
  otp: {
    type: String,
    default: null
  },
  otpExpiry: {
    type: Date,
    default: null
  },
  otpAttempts: {
    type: Number,
    default: 0
  },
  
  // Account status
  isActive: {
    type: Boolean,
    default: true
  },
  isVerified: {
    type: Boolean,
    default: false
  },
  
  // Account security
  accountLockedUntil: {
    type: Date,
    default: null
  },
  failedLoginAttempts: {
    type: Number,
    default: 0
  },
  
  // Activity tracking
  lastLogin: {
    type: Date,
    default: null
  },
  lastOtpRequest: {
    type: Date,
    default: null
  },
  
  createdAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Email is already indexed via unique: true

// Method to check if account is locked
AdminSchema.methods.canRequestOTP = function() {
  const now = Date.now();
  
  // Check if account is locked
  if (this.accountLockedUntil && now < this.accountLockedUntil) {
    const minutesLeft = Math.ceil((this.accountLockedUntil - now) / 60000);
    return { 
      allowed: false, 
      reason: `Account temporarily locked. Try again in ${minutesLeft} minutes.` 
    };
  }
  
  return { allowed: true };
};

// Method to generate OTP (6-digit for admin, hashed)
AdminSchema.methods.generateOTP = function() {
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  
  // Hash OTP before storing
  this.otp = bcrypt.hashSync(otp, 10);
  this.otpExpiry = Date.now() + 10 * 60 * 1000; // 10 minutes (longer for admin)
  this.otpAttempts = 0; // Reset attempt counter
  this.lastOtpRequest = Date.now();
  
  return otp; // Return plain OTP to send via email
};

// Method to verify OTP
AdminSchema.methods.verifyOTP = function(enteredOTP) {
  if (!this.otp || !this.otpExpiry) {
    return { success: false, message: 'No OTP found. Please request a new one.' };
  }
  
  // Check if OTP expired
  if (Date.now() > this.otpExpiry) {
    return { success: false, message: 'OTP has expired. Please request a new one.' };
  }
  
  // Check attempt limit (max 5 attempts per OTP for admin)
  if (this.otpAttempts >= 5) {
    this.clearOTP();
    return { success: false, message: 'Maximum attempts exceeded. Please request a new OTP.' };
  }
  
  // Verify OTP using bcrypt
  const isValid = bcrypt.compareSync(String(enteredOTP).trim(), this.otp);
  
  if (!isValid) {
    this.otpAttempts += 1;
    this.failedLoginAttempts += 1;
    
    // Lock account after 10 failed attempts
    if (this.failedLoginAttempts >= 10) {
      this.accountLockedUntil = Date.now() + 60 * 60 * 1000; // 1 hour
      return { 
        success: false, 
        message: 'Account locked due to too many failed attempts. Please try again in 1 hour.' 
      };
    }
    
    return { 
      success: false, 
      message: `Invalid OTP. ${5 - this.otpAttempts} attempts remaining.` 
    };
  }
  
  // OTP is valid - reset failed attempts
  this.failedLoginAttempts = 0;
  this.accountLockedUntil = null;
  
  return { success: true };
};

// Method to clear OTP
AdminSchema.methods.clearOTP = function() {
  this.otp = null;
  this.otpExpiry = null;
  this.otpAttempts = 0;
};

// Static method to check if email is authorized
AdminSchema.statics.isAuthorizedEmail = function(email) {
  const authorizedEmails = process.env.ADMIN_EMAILS?.split(',').map(e => e.trim().toLowerCase()) || [];
  return authorizedEmails.includes(email.toLowerCase());
};

// Static method to find or create admin
AdminSchema.statics.findOrCreateAdmin = async function(email, role = 'admin') {
  let admin = await this.findOne({ email: email.toLowerCase() });
  
  if (!admin) {
    admin = await this.create({
      email: email.toLowerCase(),
      role,
      isActive: true
    });
  }
  
  return admin;
};

module.exports = mongoose.model('Admin', AdminSchema);
