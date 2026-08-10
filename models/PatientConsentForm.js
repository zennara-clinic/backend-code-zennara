const mongoose = require('mongoose');

/**
 * Universal Patient Consent Form
 *
 * Digital version of Zennara's paper "UNIVERSAL PATIENT CONSENT FORM" (page 7 of
 * the clinic booklet). One form covers every treatment/procedure — the patient
 * fills it once per procedure, confirms each of the seven sections, and signs.
 *
 * The section confirmations are stored as booleans; the wording the patient
 * agreed to is pinned by `formVersion` and rendered identically in the app and
 * the admin panel (see the app's constants/consentForm.ts). This keeps the
 * legal record honest even if the copy is reworded in a later version.
 *
 * Legacy fields (acknowledgements / termsAndConditions) from the earlier consent
 * screen are kept but optional so old records still load and validate.
 */
const patientConsentFormSchema = new mongoose.Schema({
  // --- References -----------------------------------------------------------
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  bookingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Booking'
  },
  preConsultFormId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PreConsultForm'
  },

  // Which wording the patient agreed to (pins the legal text).
  formVersion: {
    type: String,
    default: 'universal-v1'
  },

  // --- Patient information (top of the form) --------------------------------
  patientName: {
    type: String,
    required: true,
    trim: true
  },
  dateOfBirth: {
    type: Date,
    default: null
  },
  age: {
    type: Number,
    default: null
  },
  gender: {
    type: String,
    enum: ['Male', 'Female', 'Other', null],
    default: null
  },
  mobile: {
    type: String,
    default: null,
    trim: true
  },

  // --- Treatment / doctor ---------------------------------------------------
  // Universal consent applies to every treatment/package, so this is not a
  // per-treatment field any more — it defaults and is no longer required.
  treatmentProcedure: {
    type: String,
    required: false,
    default: 'All treatments & packages',
    trim: true
  },
  doctorName: {
    type: String,
    required: false,
    default: 'To Be Assigned',
    trim: true
  },
  clinicName: {
    type: String,
    default: 'ZENNARA Clinics'
  },

  consentDate: {
    type: Date,
    default: Date.now,
    required: true
  },

  // --- The seven sections (each a single confirmation) ----------------------
  sections: {
    // 1. Understanding of Treatment
    understandingOfTreatment: { type: Boolean, default: false },
    // 2. Risks, Side Effects & Limitations
    risksSideEffects: { type: Boolean, default: false },
    // 3. Medical Disclosure
    medicalDisclosure: { type: Boolean, default: false },
    // 4. Use of Clinical Records (records + photos for medical documentation)
    clinicalRecords: { type: Boolean, default: false },
    // 5. Financial Terms
    financialTerms: { type: Boolean, default: false },
    // 6. Liability Clause
    liabilityClause: { type: Boolean, default: false },
    // 7. Declaration & Consent
    declaration: { type: Boolean, default: false }
  },

  // Optional, opt-in — the photo notes marketing use needs *separate* consent.
  marketingPhotoConsent: {
    type: Boolean,
    default: false
  },

  // Overall consent to treatment (mirrors section 7 / declaration).
  consentGiven: {
    type: Boolean,
    default: false,
    required: true
  },

  // --- Signatures -----------------------------------------------------------
  patientSignature: {
    type: String, // typed name "Name|Style" or base64/URL
    required: true
  },
  patientSignedAt: {
    type: Date,
    default: Date.now
  },
  doctorSignature: {
    type: String,
    default: null
  },
  doctorSignedAt: {
    type: Date,
    default: null
  },
  clinicStamp: {
    type: String, // note / reference / image URL added by the clinic
    default: null
  },

  // --- Status & clinic notes ------------------------------------------------
  status: {
    type: String,
    enum: ['Pending', 'Signed', 'Approved', 'Archived'],
    default: 'Signed',
    index: true
  },
  clinicNotes: {
    type: String,
    default: null
  },

  // --- Legacy (kept optional for older records / the retired consent screen) -
  acknowledgements: {
    type: mongoose.Schema.Types.Mixed,
    default: undefined
  },
  termsAndConditions: {
    type: mongoose.Schema.Types.Mixed,
    default: undefined
  }

}, {
  timestamps: true
});

// Indexes for efficient queries
patientConsentFormSchema.index({ userId: 1, createdAt: -1 });
patientConsentFormSchema.index({ bookingId: 1 });
patientConsentFormSchema.index({ preConsultFormId: 1 });
patientConsentFormSchema.index({ consentDate: -1 });

// True only when every section is confirmed and consent is given.
patientConsentFormSchema.methods.hasAllRequiredConsents = function () {
  const s = this.sections || {};
  return Boolean(
    s.understandingOfTreatment &&
    s.risksSideEffects &&
    s.medicalDisclosure &&
    s.clinicalRecords &&
    s.financialTerms &&
    s.liabilityClause &&
    s.declaration &&
    this.consentGiven
  );
};

module.exports = mongoose.model('PatientConsentForm', patientConsentFormSchema);
