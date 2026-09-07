const mongoose = require('mongoose');

const packageAssignmentSchema = new mongoose.Schema({
  assignmentId: {
    type: String,
    unique: true
    // Auto-generated in pre-save hook
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  packageId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Package',
    required: true
  },
  packageDetails: {
    packageName: String,
    packagePrice: Number,
    originalPrice: Number,
    services: [{
      serviceId: String,
      serviceName: String,
      /** Sessions entitled for this service at the time of sale (Package.services[].sessions). */
      sessions: { type: Number, default: null },
      servicePrice: { type: Number, default: null },
      /** Zenoti "Order" — which benefit a redemption draws from first. */
      redemptionOrder: { type: Number, default: 1 }
    }]
  },
  userDetails: {
    fullName: String,
    email: String,
    phone: String,
    patientId: String,
    memberType: String
  },
  pricing: {
    originalAmount: {
      type: Number,
      required: true
    },
    discountPercentage: {
      type: Number,
      default: 0,
      min: 0,
      max: 100
    },
    discountAmount: {
      type: Number,
      default: 0
    },
    finalAmount: {
      type: Number
      // Auto-calculated in pre-save hook
    },
    isZenMemberDiscount: {
      type: Boolean,
      default: false
    }
  },
  payment: {
    isReceived: {
      type: Boolean,
      default: false
    },
    receivedDate: {
      type: Date,
      default: null
    },
    proofUrl: {
      type: String,
      default: null
    },
    proofPublicId: {
      type: String,
      default: null
    },
    paymentMethod: {
      type: String,
      enum: ['Cash', 'Card', 'Credit Card', 'Debit Card', 'UPI', 'Bank Transfer', 'Pay at clinic', 'COD', 'Razorpay', 'Clinic', 'Other'],
      default: null
    },
    transactionId: {
      type: String,
      default: null
    },
    /** Instalments: what has been collected so far and what is still owed. */
    amountPaid: { type: Number, default: null },
    balanceDue: { type: Number, default: null }
  },
  /** The desk bill this package was sold on (null for app / legacy sales). */
  invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', default: null, index: true },
  /* ---- terms copied from the package at sale (Zenoti: the version sold) ---- */
  terms: {
    version: { type: Number, default: 1 },
    code: { type: String, default: null },
    validityDays: { type: Number, default: null },
    neverExpires: { type: Boolean, default: false },
    validityStartsAt: { type: String, enum: ['sale', 'firstRedemption'], default: 'sale' },
    graceDays: { type: Number, default: 0 },
    closeWhenConsumed: { type: Boolean, default: true },
    redeemableScope: { type: String, enum: ['organization', 'centres'], default: 'organization' },
    redeemableBranchIds: { type: [String], default: [] },
    maxFreezes: { type: Number, default: 0 },
    maxFreezeDays: { type: Number, default: 0 },
    minPartialPaymentPercent: { type: Number, default: 0 },
  },
  /** validUntil + graceDays; sessions may still be redeemed until this date. */
  graceUntil: { type: Date, default: null },
  /** Set when validity starts at the first redemption. */
  firstRedeemedAt: { type: Date, default: null },
  freeze: {
    isFrozen: { type: Boolean, default: false, index: true },
    frozenAt: { type: Date, default: null },
    frozenBy: { type: String, default: null },
    reason: { type: String, default: null },
    resumeOn: { type: Date, default: null },
  },
  freezeHistory: [{
    _id: false,
    frozenAt: Date, resumedAt: Date, days: Number, by: String, resumedBy: String, reason: String,
  }],
  /** Balance handed to another guest (Zenoti "Transferred" column). */
  transfers: [{
    _id: false,
    at: Date, by: String, toUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, toUserName: String,
    toAssignmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'PackageAssignment' },
    services: [{ _id: false, serviceId: String, serviceName: String, qty: Number }],
    reason: String,
  }],
  transferredFrom: {
    assignmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'PackageAssignment', default: null },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    userName: { type: String, default: null },
    at: { type: Date, default: null },
  },
  /** Every redemption, for the guest-profile "Redemptions" tab. */
  redemptions: [{
    _id: false,
    at: Date, serviceId: String, serviceName: String, sessionId: mongoose.Schema.Types.ObjectId,
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking' },
    invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' }, invoiceNumber: String,
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch' }, byName: String, reversed: { type: Boolean, default: false },
  }],
  refund: {
    refundedAt: { type: Date, default: null },
    amount: { type: Number, default: null },
    method: { type: String, default: null },
    reference: { type: String, default: null },
    reason: { type: String, default: null },
    byName: { type: String, default: null },
  },
  status: {
    type: String,
    enum: ['Active', 'Expired', 'Cancelled', 'Completed'],
    default: 'Active'
  },
  validFrom: {
    type: Date,
    default: Date.now
  },
  validUntil: {
    type: Date,
    default: null
  },
  // Where the package's sessions happen — the clinic the auto-created
  // appointments are placed at.
  preferredLocation: {
    type: String,
    default: ''
  },
  branchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    default: null
  },
  /**
   * The sessions in the package. The clinic may set a suggested date per
   * session (a treatment can appear more than once for a multi-session course).
   *
   * Sessions are NOT auto-booked any more. 24 hours before a suggested date —
   * and again when the package is a month from expiry — the customer is
   * emailed / WhatsApped to book the session themselves from the app. That
   * booking arrives at the desk as "Awaiting Confirmation"; confirming it in
   * the panel is what creates the Zenoti appointment.
   */
  sessions: [{
    serviceId: String,          // → Package.services[].serviceId / Consultation.id
    serviceName: String,
    scheduledDate: Date,        // clinic-set date (and time) for this session
    scheduledTime: {            // clinic-local time label, e.g. "2:30 PM" — shown verbatim,
      type: String,            // so the displayed slot never depends on server timezone.
      default: ''
    },
    // Who runs this session. A course can move between dermatologists, so the
    // choice is per session rather than per assignment. Copied onto the
    // Booking the scheduler creates, so the diary and the app agree.
    specialistId: { type: String, default: null },   // Doctor.doctorId slug
    specialistName: { type: String, default: null },
    specialistTier: { type: String, default: null },
    status: {
      type: String,
      enum: ['Scheduled', 'Booked', 'Completed', 'Cancelled'],
      default: 'Scheduled'
    },
    bookingId: {                // set once the appointment is auto-created
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Booking',
      default: null
    },
    bookingCreatedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    /** When the "book your session" nudge went out, so it is sent once. */
    reminderSentAt: { type: Date, default: null }
  }],
  /** When the "your package expires soon" nudge went out. */
  expiryReminderSentAt: { type: Date, default: null },
  usageTracking: {
    totalSessions: {
      type: Number,
      default: 0
    },
    usedSessions: {
      type: Number,
      default: 0
    },
    remainingSessions: {
      type: Number,
      default: 0
    }
  },
  notes: {
    type: String,
    default: ''
  },
  assignedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin',
    default: null
  },
  assignedByName: {
    type: String,
    default: ''
  },
  completedServices: [{
    serviceId: String,
    completedAt: Date,
    prescriptions: [String],
    serviceCard: {
      doctor: String,
      therapist: String,
      manager: String,
      grading: {
        type: Number,
        min: 0,
        max: 10
      },
      notes: String,
      createdAt: {
        type: Date,
        default: Date.now
      }
    }
  }],
  pendingServiceCards: {
    type: Map,
    of: {
      doctor: String,
      therapist: String,
      manager: String,
      grading: Number,
      notes: String,
      createdAt: Date
    },
    default: new Map()
  },
  serviceOtps: {
    type: Map,
    of: {
      otp: String,
      expiresAt: Date
    },
    default: new Map()
  },
  serviceConsents: {
    type: Map,
    of: {
      serviceId: String,
      serviceName: String,
      patientName: String,
      doctorName: String,
      termsAccepted: {
        noRefund: Boolean,
        nonTransferable: Boolean,
        expiryAccepted: Boolean,
        noRefundOnChange: Boolean,
        variableResults: Boolean,
        noGuarantee: Boolean
      },
      consentGiven: Boolean,
      signature: String,
      submittedAt: Date
    },
    default: new Map()
  },
  cancellation: {
    isCancelled: {
      type: Boolean,
      default: false
    },
    cancelledAt: Date,
    cancelledBy: String,
    reason: String
  },
  cancellationOtp: {
    otp: String,
    expiresAt: Date
  },
  zenotiPackageId: { type: String, default: null },
  zenotiInvoiceId: { type: String, default: null },
  /**
   * Zenoti's user-package id when this assignment mirrors a package the
   * customer bought AT THE CLINIC. It is the idempotency key for the mirror:
   * one Zenoti purchase is ever one assignment here, however many passes run.
   */
  zenotiUserPackageId: { type: String, default: null, trim: true },
  /** 'zenoti' = bought at the clinic (mirrored); 'panel' = assigned by staff here. */
  source: { type: String, enum: ['panel', 'zenoti'], default: 'panel', index: true },
  zenotiInvoiceNumber: { type: String, default: null },
  zenotiSyncStatus: {
    type: String,
    enum: ['pending', 'synced', 'failed', 'skipped', 'dryrun', null],
    default: null
  },
  zenotiSyncError: { type: String, default: null },
  zenotiSyncedAt: { type: Date, default: null }
}, {
  timestamps: true
});

// Generate assignment ID before saving
packageAssignmentSchema.pre('save', async function(next) {
  this._wasNew = this.isNew;
  if (!this.assignmentId) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let assignmentId;
    let isUnique = false;
    
    while (!isUnique) {
      assignmentId = 'PKG' + Array.from({ length: 8 }, () => 
        chars.charAt(Math.floor(Math.random() * chars.length))
      ).join('');
      
      const existing = await this.constructor.findOne({ assignmentId });
      if (!existing) {
        isUnique = true;
      }
    }
    
    this.assignmentId = assignmentId;
  }
  
  // Validity from the first redemption (Zenoti "Validity starts: At First Redemption").
  if (this.terms?.validityStartsAt === 'firstRedemption' && !this.validUntil && !this.terms.neverExpires) {
    const first = (this.sessions || []).filter((s) => s.status === 'Completed' && s.completedAt).map((s) => new Date(s.completedAt)).sort((a, b) => a - b)[0];
    if (first) {
      this.firstRedeemedAt = this.firstRedeemedAt || first;
      const d = new Date(this.firstRedeemedAt); d.setDate(d.getDate() + (Number(this.terms.validityDays) || 365)); this.validUntil = d;
    }
  }
  // Grace window follows validUntil.
  if (this.validUntil && Number(this.terms?.graceDays) > 0) { const g = new Date(this.validUntil); g.setDate(g.getDate() + Number(this.terms.graceDays)); this.graceUntil = g; }
  else this.graceUntil = null;

  // Calculate discount amount and final amount
  if (this.pricing.discountPercentage > 0) {
    this.pricing.discountAmount = Math.round(
      (this.pricing.originalAmount * this.pricing.discountPercentage) / 100
    );
    this.pricing.finalAmount = this.pricing.originalAmount - this.pricing.discountAmount;
  } else {
    this.pricing.finalAmount = this.pricing.originalAmount;
    this.pricing.discountAmount = 0;
  }
  
  next();
});

packageAssignmentSchema.post('save', function(doc) {
  if (doc.$locals?.skipZenotiWrite || !doc._wasNew || doc.zenotiInvoiceId) return;
  setImmediate(() => {
    try {
      require('../services/zenotiWriteService').syncPackageAssignment(doc._id).catch(() => {});
    } catch (_) { /* package sale sync is best-effort */ }
  });
});

/**
 * Sessions entitled per service (from the package definition) and sessions
 * completed per service (from the session list, falling back to the older
 * completedServices log). A package with "Exosome × 3, GFC × 2" is 5 units,
 * not 2 — comparing service counts marked such packages Completed after the
 * first session of each service (bug fixed 2026-09-06).
 */
packageAssignmentSchema.methods.serviceBalances = function() {
  // Entitlement: the snapshot's session count when recorded; otherwise the
  // number of session rows generated for that service at assignment (older
  // rows have one row per session but no count on the snapshot).
  const rowsPerService = new Map();
  (this.sessions || []).forEach((s) => { const id = String(s.serviceId || ''); if (id) rowsPerService.set(id, (rowsPerService.get(id) || 0) + 1); });
  const entitled = new Map();
  (this.packageDetails?.services || []).forEach((s) => {
    const id = String(s.serviceId || '');
    if (!id) return;
    const declared = Number(s.sessions) > 0 ? Number(s.sessions) : 0;
    entitled.set(id, (entitled.get(id) || 0) + Math.max(1, declared, declared ? 0 : (rowsPerService.get(id) || 0)));
  });
  const used = new Map();
  const sessionRows = (this.sessions || []).filter((s) => s.status === 'Completed');
  if (sessionRows.length) {
    sessionRows.forEach((s) => { const id = String(s.serviceId || ''); used.set(id, (used.get(id) || 0) + 1); });
  } else {
    (this.completedServices || []).forEach((s) => { const id = String(s.serviceId || ''); used.set(id, (used.get(id) || 0) + 1); });
  }
  const transferred = new Map();
  (this.transfers || []).forEach((t) => (t.services || []).forEach((s) => { const id = String(s.serviceId || ''); transferred.set(id, (transferred.get(id) || 0) + (Number(s.qty) || 0)); }));
  const rows = [];
  for (const [serviceId, total] of entitled) {
    const out = transferred.get(serviceId) || 0;
    const done = Math.min(total - out, used.get(serviceId) || 0);
    const def = (this.packageDetails?.services || []).find((s) => String(s.serviceId) === serviceId);
    rows.push({ serviceId, serviceName: def?.serviceName || null, order: Number(def?.redemptionOrder) || 1, entitled: total, transferred: out, used: done, balance: Math.max(0, total - out - done) });
  }
  return rows.sort((a, b) => a.order - b.order);
};

/**
 * May this package be redeemed now, here? Mirrors Zenoti's checks: status,
 * freeze, expiry (with grace), and the centres it is redeemable at.
 */
packageAssignmentSchema.methods.redeemable = function({ branchId = null, at = new Date() } = {}) {
  if (this.status !== 'Active') return { ok: false, code: 'PACKAGE_' + String(this.status).toUpperCase(), message: `This package is ${String(this.status).toLowerCase()}.` };
  if (this.freeze?.isFrozen) return { ok: false, code: 'PACKAGE_FROZEN', message: `This package is frozen${this.freeze.resumeOn ? ` until ${new Date(this.freeze.resumeOn).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' })}` : ''}. Unfreeze it first.` };
  const until = this.graceUntil || this.validUntil;
  if (until && new Date(until) < at) return { ok: false, code: 'PACKAGE_EXPIRED', message: 'This package has expired.' };
  if (this.validUntil && new Date(this.validUntil) < at && this.graceUntil) return { ok: true, grace: true, message: 'In the grace period after expiry.' };
  if (this.terms?.redeemableScope === 'centres' && (this.terms.redeemableBranchIds || []).length && branchId && !this.terms.redeemableBranchIds.map(String).includes(String(branchId))) {
    return { ok: false, code: 'PACKAGE_WRONG_CENTRE', message: 'This package can only be redeemed at the centre(s) it was sold for.' };
  }
  return { ok: true };
};

// Method to check if all services are completed
packageAssignmentSchema.methods.checkCompletion = function() {
  const rows = this.serviceBalances();
  const total = rows.reduce((n, r) => n + r.entitled, 0);
  const used = rows.reduce((n, r) => n + r.used, 0);

  if (total > 0 && used >= total && this.status !== 'Cancelled' && this.terms?.closeWhenConsumed !== false) {
    this.status = 'Completed';
    return true;
  }
  return false;
};

// Method to calculate completion percentage
packageAssignmentSchema.methods.getCompletionPercentage = function() {
  const rows = this.serviceBalances();
  const total = rows.reduce((n, r) => n + r.entitled, 0);
  if (total === 0) return 0;
  const used = rows.reduce((n, r) => n + r.used, 0);
  return Math.round((used / total) * 100);
};

const PackageAssignment = mongoose.model('PackageAssignment', packageAssignmentSchema);

module.exports = PackageAssignment;
