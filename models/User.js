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
  
  // Rate limiting for OTP requests
  otpRequestCount: {
    type: Number,
    default: 0
  },
  otpRequestWindowStart: {
    type: Date,
    default: null
  },
  
  // Account security
  isVerified: {
    type: Boolean,
    default: false
  },
  isActive: {
    type: Boolean,
    default: true
  },
  emailVerified: {
    type: Boolean,
    default: false
  },
  phoneVerified: {
    type: Boolean,
    default: false
  },
  
  // Failed login tracking
  failedLoginAttempts: {
    type: Number,
    default: 0
  },
  accountLockedUntil: {
    type: Date,
    default: null
  },
  
  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now
  },
  lastLogin: {
    type: Date,
    default: null
  },
  lastOtpRequest: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

// Index for faster queries
UserSchema.index({ email: 1 });
UserSchema.index({ phone: 1 });

// Method to check rate limiting for OTP requests
UserSchema.methods.canRequestOTP = function() {
  const now = Date.now();
  const oneHour = 60 * 60 * 1000; // 1 hour in milliseconds
  
  // Check if account is locked
  if (this.accountLockedUntil && now < this.accountLockedUntil) {
    const minutesLeft = Math.ceil((this.accountLockedUntil - now) / 60000);
    return { 
      allowed: false, 
      reason: `Account temporarily locked. Try again in ${minutesLeft} minutes.` 
    };
  }
  
  // Reset counter if outside time window (1 hour)
  if (!this.otpRequestWindowStart || now - this.otpRequestWindowStart > oneHour) {
    this.otpRequestCount = 0;
    this.otpRequestWindowStart = now;
  }
  
  // Check rate limit (max 5 requests per hour)
  if (this.otpRequestCount >= 5) {
    const timeLeft = Math.ceil((oneHour - (now - this.otpRequestWindowStart)) / 60000);
    return { 
      allowed: false, 
      reason: `Too many OTP requests. Please try again in ${timeLeft} minutes.` 
    };
  }
  
  return { allowed: true };
};

// Method to generate OTP (4-digit, hashed)
UserSchema.methods.generateOTP = function() {
  const otp = Math.floor(1000 + Math.random() * 9000).toString();
  
  // Hash OTP before storing
  this.otp = bcrypt.hashSync(otp, 10);
  this.otpExpiry = Date.now() + 5 * 60 * 1000; // 5 minutes
  this.otpAttempts = 0; // Reset attempt counter
  this.otpRequestCount += 1; // Increment request counter
  this.lastOtpRequest = Date.now();
  
  return otp; // Return plain OTP to send via email
};

// Method to verify OTP
UserSchema.methods.verifyOTP = function(enteredOTP) {
  if (!this.otp || !this.otpExpiry) {
    return { success: false, message: 'No OTP found. Please request a new one.' };
  }
  
  // Check if OTP expired
  if (Date.now() > this.otpExpiry) {
    return { success: false, message: 'OTP has expired. Please request a new one.' };
  }
  
  // Check attempt limit (max 3 attempts per OTP)
  if (this.otpAttempts >= 3) {
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
      this.accountLockedUntil = Date.now() + 30 * 60 * 1000; // Lock for 30 minutes
      return { 
        success: false, 
        message: 'Too many failed attempts. Account locked for 30 minutes.' 
      };
    }
    
    const attemptsLeft = 3 - this.otpAttempts;
    return { 
      success: false, 
      message: `Invalid OTP. ${attemptsLeft} attempt(s) remaining.` 
    };
  }
  
  // Reset counters on successful verification
  this.failedLoginAttempts = 0;
  this.accountLockedUntil = null;
  
  return { success: true };
};

// Method to clear OTP
UserSchema.methods.clearOTP = function() {
  this.otp = null;
  this.otpExpiry = null;
  this.otpAttempts = 0;
};

module.exports = mongoose.model('User', UserSchema);
