const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const logger = require('../utils/logger');

const UserSchema = new mongoose.Schema({
  // Patient ID - 8 character unique ID
  patientId: {
    type: String,
    unique: true,
    sparse: true
  },
  
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
    // A clinic-only Zenoti record may legitimately have no usable mobile. Keep
    // it in the patient list and import its history; it simply cannot use OTP
    // login until staff adds a valid number. App sign-ups still require one.
    required: [function () { return this.source !== 'zenoti'; }, 'Phone number is required'],
    trim: true,
    match: [/^\d{10}$/, 'Please enter a valid 10-digit phone number']
  },
  
  // Location (from signup step 1) - Branch name selected by user
  location: {
    type: String,
    required: [true, 'Location is required'],
    trim: true
  },

  // ---------------------------------------------------------------------------
  // Zenoti CRM linkage
  //
  // Zennara's system of record for customers is the Zenoti CRM. When a guest who
  // already exists in Zenoti signs in, we mirror a lightweight local account so
  // the rest of the app (bookings, orders, packages — all keyed by our userId)
  // keeps working, and link it back to Zenoti by guest id. Their live history
  // (appointments, purchases, memberships, packages, notes and forms) is mirrored
  // from Zenoti; unsupported provider datasets are reported explicitly.
  // ---------------------------------------------------------------------------
  // Where this account originated. 'app' = registered through the mobile app;
  // 'zenoti' = auto-provisioned on first login from an existing Zenoti guest.
  source: {
    type: String,
    enum: ['app', 'zenoti', 'reception'],
    default: 'app'
  },
  // The Zenoti guest id this account is linked to (if any). Sparse + unique so
  // two local accounts can never claim the same Zenoti guest.
  zenotiGuestId: {
    type: String,
    // No default. The index is unique+sparse, and sparse only skips documents
    // where the field is ABSENT — an explicit null is indexed, so a `default:
    // null` let exactly one app account exist before every later signup
    // failed with a duplicate-key error. Leave it unset until Zenoti links it.
    index: true,
    sparse: true,
    unique: true
  },
  // The guest's Zenoti home-center id, for center-scoped reads and defaults.
  zenotiCenterId: {
    type: String,
    default: null
  },
  // When we last pulled this guest's profile from Zenoti.
  zenotiSyncedAt: {
    type: Date,
    default: null
  },
  /**
   * Write-back status of the guest record in Zenoti.
   *
   *   pending  queued — created locally, not yet accepted by Zenoti
   *   synced   Zenoti holds this guest and zenotiGuestId is its real id
   *   failed   the write was attempted and rejected
   *   review   needs a human: a duplicate mobile, or an ambiguous match
   *   skipped  intentionally not written (e.g. already a Zenoti-origin row)
   *   dryrun   ZENOTI_WRITE_MODE=dryrun, so nothing was actually sent
   *
   * `review` exists so a patient who cannot be safely auto-matched is visible
   * in the panel rather than silently living on as a local-only record.
   */
  zenotiSyncStatus: {
    type: String,
    enum: ['pending', 'synced', 'failed', 'review', 'skipped', 'dryrun', null],
    // 'pending' from the moment a record exists: a patient created in Zennara
    // is, by definition, not yet in Zenoti. Rows imported FROM Zenoti are set
    // to 'synced' explicitly by the importer, so they never read as pending.
    default: 'pending'
  },
  zenotiSyncError: {
    type: String,
    default: null
  },
  zenotiMembershipInvoiceId: { type: String, default: null },
  zenotiMembershipSyncStatus: {
    type: String,
    enum: ['pending', 'synced', 'failed', 'skipped', 'dryrun', null],
    default: null
  },
  zenotiMembershipSyncError: { type: String, default: null },
  
  // Member Type - Only 2 types
  memberType: {
    type: String,
    enum: ['Zen Member', 'Regular Member'],
    default: 'Regular Member'
  },
  
  // Zen Membership Details
  zenMembershipStartDate: {
    type: Date,
    default: null
  },
  zenMembershipExpiryDate: {
    type: Date,
    default: null
  },
  zenMembershipAutoRenew: {
    type: Boolean,
    default: false // Default to false for one-time VIP packages
  },
  // Where the current membership came from and how it was paid, so the panel
  // can show app, clinic-desk and Zenoti memberships the same way.
  zenMembershipSource: { type: String, enum: ['app', 'admin', 'zenoti', null], default: null },
  zenMembershipPlan: { type: String, default: null },
  zenMembershipMonths: { type: Number, default: null },
  zenMembershipAmount: { type: Number, default: null },
  zenMembershipPaymentMethod: { type: String, default: null },
  zenMembershipPaymentStatus: { type: String, enum: ['paid', 'pending', null], default: null },
  zenMembershipPaymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', default: null },
  zenMembershipGrantedBy: { type: String, default: null },
  
  // Additional Details (from signup step 3)
  //
  // For accounts created through the app these are collected at signup and are
  // required. Accounts auto-provisioned from a Zenoti guest (source === 'zenoti')
  // may not have them yet — Zenoti often has no DOB on file — so they are only
  // required for app-originated accounts and can be completed later in-app.
  dateOfBirth: {
    type: String,
    required: [function () { return this.source === 'app'; }, 'Date of birth is required']
  },
  gender: {
    type: String,
    required: [function () { return this.source === 'app'; }, 'Gender is required'],
    enum: ['Male', 'Female', 'Other']
  },
  
  // Medical History & Lifestyle
  medicalHistory: {
    type: String,
    default: ''
  },
  /** Explicit tick from the app's Allergies screen — drives panel filters. */
  hasDrugAllergy: {
    type: Boolean,
    default: false
  },
  drugAllergies: {
    type: String,
    default: ''
  },
  dietaryPreferences: {
    type: [String],
    default: []
  },
  smoking: {
    type: String,
    enum: ['Yes', 'No', 'Occasionally', ''],
    default: ''
  },
  drinking: {
    type: String,
    enum: ['Yes', 'No', 'Occasionally', 'Socially', ''],
    default: ''
  },
  additionalInfo: {
    type: String,
    default: ''
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
  
  // Privacy & Data Protection Compliance (DPDPA 2023, IT Act 2000)
  privacyPolicyConsent: {
    accepted: {
      type: Boolean,
      default: false
    },
    version: {
      type: String,
      default: '1.0'
    },
    acceptedAt: {
      type: Date,
      default: null
    },
    ipAddress: {
      type: String,
      default: null
    }
  },
  termsOfServiceConsent: {
    accepted: {
      type: Boolean,
      default: false
    },
    version: {
      type: String,
      default: '1.0'
    },
    acceptedAt: {
      type: Date,
      default: null
    },
    ipAddress: {
      type: String,
      default: null
    }
  },
  dataRetentionConsent: {
    accepted: {
      type: Boolean,
      default: true // Implied by using service
    },
    retentionPeriodYears: {
      type: Number,
      default: 3 // Clinical Establishments Act requirement
    },
    acceptedAt: {
      type: Date,
      default: Date.now
    }
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
  
  // Statistics for admin panel
  totalVisits: {
    type: Number,
    default: 0
  },
  appOpenCount: {
    type: Number,
    default: 0,
    description: 'Number of times user has opened/logged into the app'
  },
  totalSpent: {
    type: Number,
    default: 0
  },
  upcomingAppointments: {
    type: Number,
    default: 0
  },
  
  // Bank Details for Refunds (COD orders)
  refundBankDetails: {
    accountHolderName: {
      type: String,
      default: null
    },
    bankName: {
      type: String,
      default: null
    },
    accountNumber: {
      type: String,
      default: null
    },
    ifscCode: {
      type: String,
      default: null
    },
    upiId: {
      type: String,
      default: null
    },
    preferredMethod: {
      type: String,
      enum: ['Bank Transfer', 'UPI', null],
      default: null
    },
    isVerified: {
      type: Boolean,
      default: false
    },
    addedAt: {
      type: Date,
      default: null
    },
    lastUpdatedAt: {
      type: Date,
      default: null
    }
  },
  
  // Phone push tokens (Expo). Several devices may share one account.
  pushTokens: [{
    token: { type: String, required: true },
    platform: { type: String, default: null },
    updatedAt: { type: Date, default: Date.now }
  }],
  // What the guest wants to hear about. Every channel defaults to on; the
  // notification helper and the WhatsApp sender consult these before sending.
  notificationPreferences: {
    appointments: { type: Boolean, default: true },
    prescriptions: { type: Boolean, default: true },
    orders: { type: Boolean, default: true },
    packages: { type: Boolean, default: true },
    promotions: { type: Boolean, default: true },
    whatsapp: { type: Boolean, default: true },
    push: { type: Boolean, default: true }
  },

  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now
  },
  // When the clinic first registered this guest in Zenoti (guest.created_date).
  // For an imported patient this — not the import run — is the join date.
  zenotiCreatedAt: {
    type: Date,
    default: null
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

// Index for faster queries (email and patientId already indexed via unique: true)
UserSchema.index({ phone: 1 });

// Pre-save hook to generate patient ID
UserSchema.pre('save', async function(next) {
  // Only generate patientId if it doesn't exist
  if (!this.patientId) {
    // Generate 8-character patient ID: ZEN + 5 random alphanumeric characters
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let patientId;
    let isUnique = false;
    
    // Keep generating until we get a unique ID
    while (!isUnique) {
      patientId = 'ZEN' + Array.from({ length: 5 }, () => 
        chars.charAt(Math.floor(Math.random() * chars.length))
      ).join('');
      
      // Check if this ID already exists
      const existing = await this.constructor.findOne({ patientId });
      if (!existing) {
        isUnique = true;
      }
    }
    
    this.patientId = patientId;
  }
  next();
});

// Remember whether this save is the document's first, so the post-save hook can
// tell a brand-new signup apart from a routine update.
UserSchema.pre('save', function(next) {
  this._wasNew = this.isNew;
  this._zenotiProfileChanged = [
    'fullName', 'phone', 'email', 'location', 'gender', 'dateOfBirth',
  ].some((path) => this.isModified(path));
  this._zenotiMembershipChanged = this.isModified('memberType') && this.memberType === 'Zen Member';
  next();
});

// When a NEW app account is created (and isn't already a linked Zenoti guest),
// mirror it into Zenoti so every customer ends up in the CRM. Fire-and-forget:
// the write service is gated by ZENOTI_WRITE_MODE and never throws here.
UserSchema.post('save', function(doc) {
  if (doc.$locals?.skipZenotiWrite) return;
  if (!doc._wasNew) return;
  if (doc.zenotiGuestId) return; // already a Zenoti guest
  setImmediate(() => {
    try {
      require('../services/zenotiWriteService').ensureGuest(doc).catch(() => {});
    } catch (_) { /* never let CRM wiring affect account creation */ }
  });
});

UserSchema.post('save', function(doc) {
  if (doc.$locals?.skipZenotiWrite || !doc._zenotiMembershipChanged || doc.zenotiMembershipInvoiceId) return;
  setImmediate(() => {
    try {
      require('../services/zenotiWriteService').syncMembership(doc._id).catch(() => {});
    } catch (_) { /* membership invoice sync is best-effort */ }
  });
});

// Keep edits to an already-linked patient in Zenoti as well. Inbound imports
// set skipZenotiWrite so this cannot create a reflection loop.
UserSchema.post('save', function(doc) {
  if (doc.$locals?.skipZenotiWrite || doc._wasNew || !doc._zenotiProfileChanged || !doc.zenotiGuestId) return;
  setImmediate(() => {
    try {
      require('../services/zenotiWriteService').syncGuestProfile(doc._id).catch(() => {});
    } catch (_) { /* profile write-back is best-effort */ }
  });
});

// Method to check rate limiting for OTP requests
UserSchema.methods.canRequestOTP = function() {
  const now = Date.now();
  
  // Check if account is locked only
  if (this.accountLockedUntil && now < this.accountLockedUntil) {
    const minutesLeft = Math.ceil((this.accountLockedUntil - now) / 60000);
    return { 
      allowed: false, 
      reason: `Account temporarily locked. Try again in ${minutesLeft} minutes.` 
    };
  }
  
  // Rate limiting removed - always allow OTP requests
  return { allowed: true };
};

// Method to generate OTP (4-digit, hashed)
UserSchema.methods.generateOTP = function() {
  const otp = Math.floor(1000 + Math.random() * 9000).toString();
  
  // Hash OTP before storing
  this.otp = bcrypt.hashSync(otp, 10);
  this.otpExpiry = Date.now() + 5 * 60 * 1000; // 5 minutes
  this.otpAttempts = 0; // Reset attempt counter
  this.lastOtpRequest = Date.now();
  
  return otp; // Return plain OTP to send via email
};

// Method to verify OTP
UserSchema.methods.verifyOTP = function(enteredOTP) {
  // Special bypass for Apple Review demo account
  if (this.phone === '8945515335' && String(enteredOTP).trim() === '9876') {
    // Reset counters for demo account
    this.failedLoginAttempts = 0;
    this.accountLockedUntil = null;
    return { success: true };
  }
  
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

// Method to check if VIP Wellness Package is still active
UserSchema.methods.isVIPMembershipActive = function() {
  if (this.memberType !== 'Zen Member') {
    return false;
  }
  
  if (!this.zenMembershipExpiryDate) {
    return false;
  }
  
  // Check if expiry date is in the future
  return new Date(this.zenMembershipExpiryDate) > new Date();
};

// Method to get remaining days in membership
UserSchema.methods.getMembershipDaysRemaining = function() {
  if (!this.isVIPMembershipActive()) {
    return 0;
  }
  
  const now = new Date();
  const expiry = new Date(this.zenMembershipExpiryDate);
  const diffTime = expiry - now;
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  
  return diffDays > 0 ? diffDays : 0;
};

module.exports = mongoose.model('User', UserSchema);
