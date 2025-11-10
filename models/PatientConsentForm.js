const mongoose = require('mongoose');

const patientConsentFormSchema = new mongoose.Schema({
  // User Reference
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  // Booking Reference
  bookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Booking'
  },

  // Pre-Consult Form Reference (optional)
  preConsultFormId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PreConsultForm'
  },

  // Patient Information
  patientName: {
    type: String,
    required: true,
    trim: true
  },

  // Doctor and Treatment Information
  doctorName: {
    type: String,
    required: true,
    trim: true
  },
  treatmentProcedure: {
    type: String,
    required: true,
    trim: true
  },

  // Consent Date
  consentDate: {
    type: Date,
    default: Date.now,
    required: true
  },

  // Acknowledgements
  acknowledgements: {
    hadOpportunityToAskQuestions: {
      type: Boolean,
      default: true
    },
    questionsAnsweredSatisfactorily: {
      type: Boolean,
      default: true
    },
    noObjectionToClinicalRecordUse: {
      type: Boolean,
      default: true
    },
    notHoldingClinicResponsible: {
      type: Boolean,
      default: true
    },
    variableResultsExplained: {
      type: Boolean,
      default: true
    },
    improvementNotGuaranteed: {
      type: Boolean,
      default: true
    }
  },

  // Terms & Conditions Agreement
  termsAndConditions: {
    noRefundPolicy: {
      type: Boolean,
      default: false,
      required: true
    },
    nonTransferableServices: {
      type: Boolean,
      default: false,
      required: true
    },
    treatmentExpiry: {
      accepted: {
        type: Boolean,
        default: false,
        required: true
      },
      expiryDetails: {
        type: String,
        default: 'Treatments of 3-6 sessions will expire after 12 months. Treatments of 7-10 sessions will expire after 18 months.'
      }
    },
    noRefundOnDateChange: {
      type: Boolean,
      default: false,
      required: true
    }
  },

  // Consent to Treatment
  consentGiven: {
    type: Boolean,
    default: false,
    required: true
  },

  // Signatures
  patientSignature: {
    type: String, // base64 or URL
    required: true
  },
  patientSignedAt: {
    type: Date,
    default: Date.now
  },
  doctorSignature: {
    type: String, // base64 or URL
    default: null
  },
  doctorSignedAt: {
    type: Date,
    default: null
  },

  // Form Status
  status: {
    type: String,
    enum: ['Pending', 'Signed', 'Approved', 'Archived'],
    default: 'Pending'
  },

  // Additional Notes
  clinicNotes: {
    type: String,
    default: null
  }

}, {
  timestamps: true
});

// Indexes for efficient queries
patientConsentFormSchema.index({ userId: 1, createdAt: -1 });
patientConsentFormSchema.index({ bookingId: 1 });
patientConsentFormSchema.index({ preConsultFormId: 1 });
patientConsentFormSchema.index({ consentDate: -1 });

// Method to check if all required consents are given
patientConsentFormSchema.methods.hasAllRequiredConsents = function() {
  return this.termsAndConditions.noRefundPolicy &&
         this.termsAndConditions.nonTransferableServices &&
         this.termsAndConditions.treatmentExpiry.accepted &&
         this.termsAndConditions.noRefundOnDateChange &&
         this.consentGiven;
};

module.exports = mongoose.model('PatientConsentForm', patientConsentFormSchema);
