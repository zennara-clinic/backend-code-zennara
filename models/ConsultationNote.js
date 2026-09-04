const mongoose = require('mongoose');

/**
 * What a doctor writes during a consultation.
 *
 * Bookings carry scheduling and payment; they have no room for the clinical
 * record. Without this collection the doctor panel's consultation screen has
 * nowhere to save a note or a prescription, so notes lived only in the
 * browser and vanished on refresh.
 *
 * One note per booking. Saving again updates the same record and appends to
 * `revisions`, because a clinical note is evidence: it may be corrected, but
 * the earlier version is never silently replaced.
 */
const prescriptionItemSchema = new mongoose.Schema(
  {
    /** Free text as the doctor selected or typed it, e.g. "Tab Doxybond LB". */
    medicine: { type: String, required: true, trim: true },
    /** "500 mg", "0.1%" — the strength, kept apart from the dose. */
    strength: { type: String, default: null, trim: true },
    /** Tablet, cream, serum, gel — as the clinic dispenses it. */
    formulation: { type: String, default: null, trim: true },
    dosage: { type: String, default: null, trim: true },
    frequency: { type: String, default: null, trim: true },
    duration: { type: String, default: null, trim: true },
    /** Morning / night / after food — when to take it. */
    timing: { type: String, default: null, trim: true },
    instructions: { type: String, default: null, trim: true },
    /**
     * Set when the line is a Zennara retail product rather than a drug, so
     * the printed slip can separate "recommended products" from medicines and
     * the pharmacy knows what to dispense.
     */
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    /** Availability at the time of prescribing — informational, never a price. */
    availableQuantity: { type: Number, default: null },
    /** Schedule H drugs need a doctor's signature on the printed slip. */
    isScheduleH: { type: Boolean, default: false },
  },
  { _id: false },
);

const consultationNoteSchema = new mongoose.Schema(
  {
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Booking',
      required: true,
      unique: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    /** Doctor slug from the Doctor collection — matches Booking.specialistId. */
    doctorId: {
      type: String,
      default: null,
      index: true,
    },
    doctorName: {
      type: String,
      default: null,
      trim: true,
    },
    /** The Admin account that saved it, for the audit trail. */
    savedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null,
    },

    complaint: { type: String, default: '' },
    examination: { type: String, default: '' },
    assessment: { type: String, default: '' },
    plan: { type: String, default: '' },

    /** Data-URL or hosted image of the annotation pad. */
    sketch: { type: String, default: null },

    prescription: { type: [prescriptionItemSchema], default: [] },

    /** When (and where) the signed prescription was emailed to the guest. */
    prescriptionEmailedAt: { type: Date, default: null },
    prescriptionEmailedTo: { type: String, default: null },

    /** Services or packages assigned out of this consultation. */
    assignedServices: [
      {
        serviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Consultation', default: null },
        packageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Package', default: null },
        name: { type: String, required: true },
        sessions: { type: Number, default: 1 },
      },
    ],

    /* --- Diagnosis (2026-09 prescription builder) ------------------------
     * Structured rather than folded into `assessment`, so a diagnosis can be
     * reported on and carried onto the printed slip in its own right.
     */
    primaryDiagnosis: { type: String, default: '', trim: true },
    secondaryDiagnosis: { type: String, default: '', trim: true },

    /* --- Advice ---------------------------------------------------------- */
    skinCareAdvice: { type: String, default: '', trim: true },
    lifestyleAdvice: { type: String, default: '', trim: true },
    precautions: { type: String, default: '', trim: true },

    followUpDate: { type: Date, default: null },

    status: {
      type: String,
      enum: ['Draft', 'Completed'],
      default: 'Draft',
      index: true,
    },
    completedAt: { type: Date, default: null },

    /*
     * Signing — the clinical/operational boundary.
     *
     * Reception may PREPARE a prescription (drug names, dosages, the
     * operational detail), but only an authorised dermatologist may sign it.
     * That distinction is enforced server-side by the prescriptions.sign
     * permission, never by hiding a button: an unsigned prescription must not
     * be printable or sendable, and a signed one must not be silently edited.
     *
     * Any edit after signing clears the signature and returns the document to
     * unsigned, so a signature can never end up attached to text the
     * dermatologist did not approve.
     */
    prescriptionSigned: { type: Boolean, default: false, index: true },
    prescriptionSignedAt: { type: Date, default: null },
    prescriptionSignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    prescriptionSignedByName: { type: String, default: null, trim: true },
    /** The registration number printed under the signature. */
    prescriptionSignedByRegistration: { type: String, default: null, trim: true },

    // Zenoti guest-note mirror for the clinical record/prescription.
    zenotiNoteId: { type: String, default: null, index: true },
    zenotiSyncStatus: {
      type: String,
      enum: ['pending', 'synced', 'failed', 'skipped', 'dryrun', null],
      default: null,
    },
    zenotiSyncError: { type: String, default: null },
    zenotiSyncedAt: { type: Date, default: null },

    /** Snapshots of the note as it stood before each subsequent save. */
    revisions: [
      {
        savedAt: { type: Date, default: Date.now },
        savedByEmail: { type: String, default: null },
        snapshot: { type: Object, default: {} },
      },
    ],
  },
  { timestamps: true },
);

consultationNoteSchema.index({ doctorId: 1, createdAt: -1 });
consultationNoteSchema.index({ userId: 1, createdAt: -1 });

consultationNoteSchema.pre('save', function (next) {
  this._clinicalChanged = [
    'complaint', 'examination', 'assessment', 'plan', 'prescription',
    'primaryDiagnosis', 'secondaryDiagnosis',
    'skinCareAdvice', 'lifestyleAdvice', 'precautions',
    'followUpDate', 'doctorName', 'status',
  ].some((path) => this.isModified(path));
  next();
});

consultationNoteSchema.post('save', function (doc) {
  if (doc.$locals?.skipZenotiWrite || !doc._clinicalChanged) return;
  setImmediate(() => {
    try {
      require('../services/zenotiWriteService').syncConsultationNote(doc._id).catch(() => {});
    } catch (_) { /* a Zenoti outage never loses the local clinical note */ }
  });
});

module.exports = mongoose.model('ConsultationNote', consultationNoteSchema);
