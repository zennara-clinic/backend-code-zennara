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

  /*
   * Presenting complaint — added 2026-09 so the dermatologist reads the story
   * before the patient sits down, not during the consultation.
   *
   * These are deliberately free text rather than another checkbox grid: the
   * useful part of "how long has this been going on" is the patient's own
   * wording, and a fixed list of durations or past treatments would be wrong
   * for half of them.
   */
  symptomDuration: {
    type: String,
    default: null,
    trim: true,
    maxlength: 200,
  },
  previousTreatments: {
    type: String,
    default: null,
    trim: true,
    maxlength: 2000,
  },
  currentMedications: {
    type: String,
    default: null,
    trim: true,
    maxlength: 2000,
  },
  /**
   * Pregnancy status. Clinically load-bearing — several dermatology drugs and
   * most laser and peel protocols are contraindicated in pregnancy — so it is
   * an explicit field rather than something buried in free text.
   * 'not_applicable' is the default so no one is asked to answer it wrongly.
   */
  pregnancyStatus: {
    type: String,
    enum: ['not_applicable', 'not_pregnant', 'pregnant', 'breastfeeding', 'planning', 'prefer_not_to_say'],
    default: 'not_applicable',
  },
  /** Photographs the patient attached with the form (S3 URLs). */
  photos: [{
    _id: false,
    url: { type: String, required: true, trim: true },
    caption: { type: String, default: '', trim: true },
    uploadedAt: { type: Date, default: Date.now },
  }],
  /** Anything else the patient wants the dermatologist to know. */
  patientNotes: {
    type: String,
    default: null,
    trim: true,
    maxlength: 2000,
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
      default: false
      // Note: Consent validation is handled at application level
      // Users can skip consent, but it's strongly recommended for legal compliance
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

// Field-level encryption for sensitive health data (DPDPA 2023 compliance).
//
// mongoose-field-encryption generates a fresh random 16-byte IV for every
// value and stores it alongside the ciphertext. Supplying one fixed salt here
// was both unnecessary and less secure; worse, a malformed environment value
// disabled encryption completely. Only the stable secret is required.
const encryptionSecret = process.env.ENCRYPTION_SECRET;
if (encryptionSecret?.trim()) {
  preConsultFormSchema.plugin(encrypt, {
    fields: [
      'drugAllergies',
      'otherAllergies',
      'medicalHistory',
      'additionalInfo',
      'lastMenstrualPeriod',
      // Presenting complaint (2026-09). Free text describing symptoms, past
      // treatment and current drugs is health data and is encrypted with the
      // rest.
      'symptomDuration',
      'previousTreatments',
      'currentMedications',
      'patientNotes',
      /*
       * `pregnancyStatus` is deliberately NOT encrypted.
       *
       * It is an enum, and the plugin stores ciphertext as a string — the enum
       * validator would then reject every encrypted value and no form would
       * save. It also has to stay queryable so a contraindication warning can
       * be shown against a booking. It carries a single coded value rather
       * than free narrative, and access is already restricted to clinical
       * staff.
       */
    ],
    secret: encryptionSecret,
    encryptNull: false,
  });
  console.log('🔒 Health data encryption enabled for PreConsultForm');
} else if (process.env.NODE_ENV === 'production') {
  // Never let a production process silently persist new clinical data in
  // plaintext. The service must be given its stable encryption secret first.
  throw new Error('ENCRYPTION_SECRET is required in production. Refusing to store health data unencrypted.');
} else {
  console.warn('⚠️  ENCRYPTION_SECRET is not configured. Health data encryption is disabled outside production.');
}

// Indexes for efficient queries
preConsultFormSchema.index({ userId: 1, createdAt: -1 });
preConsultFormSchema.index({ clientId: 1 });
preConsultFormSchema.index({ bookingId: 1 });

module.exports = mongoose.model('PreConsultForm', preConsultFormSchema);
