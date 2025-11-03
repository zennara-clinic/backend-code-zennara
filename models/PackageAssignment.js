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
      enum: ['Cash', 'Card', 'UPI', 'Bank Transfer', 'Other'],
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
  }
}, {
  timestamps: true
});

// Generate assignment ID before saving
packageAssignmentSchema.pre('save', async function(next) {
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
