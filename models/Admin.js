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
  /** Explicit link to the Doctor profile for role `doctor` logins. */
  doctorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Doctor',
    default: null
  },
  /** Home centre for floor staff (therapists) — pins their panel to it. */
  branchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    default: null
  },
  /** Centres a therapist works at (like a dermatologist's availableCentres). */
  branchIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch'
  }],
  role: {
    type: String,
    // 'super_admin' runs the clinic-wide admin panel with every permission;
    // 'doctor' and 'therapist' back the dermatologist and floor panels and sign
    // in through the same flow. 'staff' is a general admin-panel account whose
    // access is defined entirely by its assigned custom role + direct grants
    // below — it holds no permission it was not given.
    enum: ['super_admin', 'doctor', 'therapist', 'staff'],
    default: 'super_admin'
  },
  /**
   * RBAC (admin-panel granular access). `customRoleId` points at a Role bundle;
   * `permissions` are direct grants layered on top of it. Effective access is
   * the union of the two (super_admin ignores both and holds everything). See
   * middleware/auth.js `loadEffectivePermissions`.
   */
  customRoleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Role',
    default: null,
  },
  permissions: {
    type: [String],
    default: [],
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
  /** Optional password login (set by an admin from Staff & roles / the dermatologist page). */
  passwordHash: { type: String, default: null, select: false },
  /**
   * Plaintext copy of the password so super admins can look it up from the
   * panel (clinic requirement). Never selected by default and only exposed
   * through the audited reveal endpoints. Passwords set before this field
   * existed have no copy and can only be reset.
   */
  passwordPlain: { type: String, default: null, select: false },
  passwordSetAt: { type: Date, default: null },
  phone: { type: String, default: null, trim: true },
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
  /**
   * Walkthroughs this person has already seen, by tour key ("tour-doctor",
   * "module-consultation", …).
   *
   * This used to live in the panel's localStorage, so the first-login tour
   * replayed on every new browser, profile or cleared cache — which is exactly
   * the "it keeps showing again" complaint. Storing it against the account
   * makes "only on first login" true per person rather than per device.
   * Clearing the array is what "View tutorial again" does.
   */
  toursSeen: {
    type: [String],
    default: [],
  },

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

/**
 * Who may sign in: the env super-admin list, plus any active staff account
 * created in the panel (dermatologists, therapists, reception). Returns the
 * Admin record (created on the fly for env emails) or null.
 */
AdminSchema.statics.resolveLogin = async function(email) {
  const e = String(email || '').toLowerCase().trim();
  if (!e) return null;
  if (this.isAuthorizedEmail(e)) return this.findOrCreateAdmin(e);
  const staff = await this.findOne({ email: e });
  return staff && staff.isActive !== false ? staff : null;
};

AdminSchema.methods.setPassword = function(plain) {
  this.passwordHash = bcrypt.hashSync(String(plain), 10);
  this.passwordPlain = String(plain);
  this.passwordSetAt = new Date();
};
AdminSchema.methods.checkPassword = function(plain) {
  return !!this.passwordHash && bcrypt.compareSync(String(plain || ''), this.passwordHash);
};

// Static method to find or create admin
AdminSchema.statics.findOrCreateAdmin = async function(email, role = 'super_admin') {
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
