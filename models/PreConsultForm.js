const mongoose = require('mongoose');

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
    ref: 'Booking',
    index: true
  },

  // Personal Information
  clientId: {
    type: String,
    required: true,
    index: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  dateOfBirth: {
    type: Date,
    required: true
  },
  gender: {
    type: String,
    required: true,
    enum: ['Male', 'Female', 'Other']
  },
  phoneNumber: {
    type: String,
    required: true,
    trim: true
  },
  email: {
    type: String,
    required: true,
    lowercase: true,
    trim: true
  },
  status: {
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
    thyroidDisorder: { type: Boolean, default: false },
    menstrualHistory: { 
      type: String, 
      enum: ['Regular', 'Irregular', 'N/A'],
      default: 'N/A'
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
    required: true
  },
  doctorSignature: {
    type: String, // base64 or URL
    default: null
  },

  // Form Status
  status: {
    type: String,
    enum: ['Draft', 'Submitted', 'Reviewed'],
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

// Indexes for efficient queries
preConsultFormSchema.index({ userId: 1, createdAt: -1 });
preConsultFormSchema.index({ clientId: 1 });
preConsultFormSchema.index({ bookingId: 1 });

module.exports = mongoose.model('PreConsultForm', preConsultFormSchema);
