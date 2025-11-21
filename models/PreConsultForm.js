const mongoose = require('mongoose');
const encrypt = require('mongoose-field-encryption').fieldEncryption;

const preConsultFormSchema = new mongoose.Schema({
  // User Reference
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  // Booking Reference (optional - can be filled without booking)
  bookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Booking'
  },

  // Personal Information
  clientId: {
    type: String,
    required: false,
    default: null
  },
  name: {
    type: String,
    required: false,
    default: null,
    trim: true
  },
  dateOfBirth: {
    type: Date,
    required: false,
    default: null
  },
  gender: {
    type: String,
    required: false,
    enum: ['Male', 'Female', 'Other'],
    default: 'Male'
  },
  phoneNumber: {
    type: String,
    required: false,
    default: null,
    trim: true
  },
  email: {
    type: String,
    required: false,
    default: null,
    lowercase: true,
    trim: true
  },
  maritalStatus: {
    type: String,
    enum: ['Single', 'Married', 'Other'],
    default: 'Single'
  },
  numberOfChildren: {
    type: Number,
    default: 0
  },
  planningForPregnancy: {
    type: Boolean,
    default: false
  },
  lastMenstrualPeriod: {
    type: String,
    default: null
  },

  // How they found Zennara
  referralSource: {
    type: String,
    default: null
  },
  referredBy: {
    type: String,
    default: null
  },

  // Reason for Visit
  reasonForVisit: {
    skin: { type: Boolean, default: false },
    hair: { type: Boolean, default: false },
    body: { type: Boolean, default: false },
    yoga: { type: Boolean, default: false },
    nutrition: { type: Boolean, default: false }
  },

  // Skin Concerns
  skinConcerns: {
    acnePimple: { type: Boolean, default: false },
    scar: { type: Boolean, default: false },
    pigmentation: { type: Boolean, default: false },
    skinSagging: { type: Boolean, default: false },
    skinTightening: { type: Boolean, default: false },
    wartSkinTag: { type: Boolean, default: false }
  },

  // Hair Concerns
  hairConcerns: {
    hairFallThinning: { type: Boolean, default: false },
    hairRemoval: { type: Boolean, default: false },
    others: { type: String, default: null }
  },

  // Medical History
  medicalHistory: {
    hypertension: { type: Boolean, default: false },
    diabetes: { type: Boolean, default: false },
    thyroid: { type: Boolean, default: false },
    thyroidDisorder: { type: Boolean, default: false }, // Keep for backward compatibility
    menstrualHistory: { 
      type: String, 
      enum: ['Regular', 'Irregular', 'N/A'],
      default: 'Regular'
    }
  },

  // Allergies
  drugAllergies: {
    type: String,
    default: null
  },
  otherAllergies: {
    type: String,
    default: null
  },

  // Daily Routine
  dailyRoutine: {
    cleanser: { type: String, default: null },
    moisturiser: { type: String, default: null },
    sunscreen: { type: String, default: null },
    otherProducts: { type: String, default: null }
  },

  // Diet
  diet: {
    type: {
      type: String,
      enum: ['Veg', 'Non-Veg', 'Vegan', 'Other'],
      default: 'Veg'
    },
    waterIntakeLiters: {
      type: Number,
      default: null
    }
  },

  // Additional Questions
  additionalInfo: {
    newSkincareProducts: {
      used: { type: Boolean, default: false },
      details: { type: String, default: null }
    },
    recentSalonVisit: {
      visited: { type: Boolean, default: false },
      details: { type: String, default: null }
    },
    pastTreatmentsSurgeries: {
      had: { type: Boolean, default: false },
      details: { type: String, default: null }
    }
  },

  // Signatures
  clientSignature: {
    type: String, // base64 or URL
    default: null
  },
  doctorName: {
    type: String,
    required: false,
    default: null
  },
  doctorSignature: {
    type: String, // base64 or URL
    default: null
  },

  // Health Data Consent (DPDPA 2023 Compliance)
  healthDataConsent: {
    accepted: {
      type: Boolean,
      required: [true, 'Health data consent is required'],
      default: false
    },
    acceptedAt: {
      type: Date,
      default: null
    },
    ipAddress: {
      type: String,
      default: null
    },
    consentText: {
      type: String,
      default: 'I consent to the collection, storage, and processing of my health information for medical treatment purposes as per DPDPA 2023 and Clinical Establishments Act.'
    }
  },

  // Form Status
  status: {
    type: String,
    enum: ['Draft', 'Submitted', 'Approved', 'Reviewed', 'Rejected'],
    default: 'Draft',
    index: true
  },

  // Date of visit
  dateOfVisit: {
    type: Date,
    default: Date.now
  }

}, {
  timestamps: true
});

// Field-level encryption for sensitive health data (DPDPA 2023 compliance)
// Only encrypt if encryption keys are provided
if (process.env.ENCRYPTION_SECRET && process.env.ENCRYPTION_SALT) {
  preConsultFormSchema.plugin(encrypt, {
    fields: [
      'drugAllergies',
      'otherAllergies', 
      'medicalHistory',
      'additionalInfo',
      'lastMenstrualPeriod'
    ],
    secret: process.env.ENCRYPTION_SECRET,
    saltGenerator: () => process.env.ENCRYPTION_SALT,
    useAes256Gcm: true
  });
  console.log('🔒 Health data encryption enabled for PreConsultForm');
} else {
  console.warn('⚠️  Encryption keys not found. Health data will NOT be encrypted at rest.');
}

// Indexes for efficient queries
preConsultFormSchema.index({ userId: 1, createdAt: -1 });
preConsultFormSchema.index({ clientId: 1 });
preConsultFormSchema.index({ bookingId: 1 });

module.exports = mongoose.model('PreConsultForm', preConsultFormSchema);
