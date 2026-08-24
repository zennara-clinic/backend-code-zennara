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
      serviceName: String
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
      enum: ['Cash', 'Card', 'Credit Card', 'Debit Card', 'UPI', 'Bank Transfer', 'Pay at clinic', 'COD', 'Razorpay', 'Other'],
      default: null
    },
    transactionId: {
      type: String,
      default: null
    }
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
  // The scheduled sessions. The clinic sets a date per session (a treatment can
  // appear more than once for multi-session treatments). 24h before each
  // scheduledDate the scheduler auto-creates a Booking and links it here.
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
    completedAt: { type: Date, default: null }
  }],
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

// Method to check if all services are completed
packageAssignmentSchema.methods.checkCompletion = function() {
  const totalServices = this.packageDetails.services.length;
  const completedServices = this.completedServices.length;
  
  if (totalServices > 0 && completedServices === totalServices && this.status !== 'Cancelled') {
    this.status = 'Completed';
    return true;
  }
  return false;
};

// Method to calculate completion percentage
packageAssignmentSchema.methods.getCompletionPercentage = function() {
  const totalServices = this.packageDetails.services.length;
  if (totalServices === 0) return 0;
  const completedServices = this.completedServices.length;
  return Math.round((completedServices / totalServices) * 100);
};

const PackageAssignment = mongoose.model('PackageAssignment', packageAssignmentSchema);

module.exports = PackageAssignment;
