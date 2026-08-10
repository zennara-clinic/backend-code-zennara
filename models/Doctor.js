const mongoose = require('mongoose');

/**
 * The dermatology team.
 *
 * Until now this list lived as a hard-coded constant inside the mobile app
 * (`Zennara App/constants/doctors.ts`), which meant the clinic could not add a
 * doctor, change a fee or retire a profile without shipping an app release.
 * The unified panel edits this collection instead; the app and the panel both
 * read it.
 *
 * `doctorId` is the stable slug both the app and `DermatologistAvailability`
 * key off ("rickson-pereira"), so it must not change once a doctor exists.
 */
const doctorSchema = new mongoose.Schema(
  {
    doctorId: {
      type: String,
      required: [true, 'doctorId is required'],
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    name: {
      type: String,
      required: [true, 'Doctor name is required'],
      trim: true,
    },
    /** Official portrait URL. Null renders an initials avatar in both clients. */
    photo: {
      type: String,
      default: null,
    },
    tier: {
      type: String,
      enum: ['senior-consultant', 'consultant-dermatologist'],
      required: true,
      index: true,
    },
    /** Neutral, non-ranking label shown on profile and selection cards. */
    level: {
      type: String,
      enum: ['specialist', 'senior', 'dermatologist'],
      default: 'dermatologist',
    },
    designation: {
      type: String,
      default: null,
      trim: true,
    },
    /** Home centre. Empty is valid — some doctors rotate. */
    branch: {
      type: String,
      default: null,
      trim: true,
    },
    /**
     * Centre names this doctor can be booked at. The booking flow filters the
     * centre picker on these; `DermatologistAvailability` holds the same
     * relationship by branch _id for the slot engine.
     */
    availableCentres: [{ type: String, trim: true }],
    qualifications: [{ type: String, trim: true }],
    experienceYears: {
      type: Number,
      default: 0,
      min: 0,
    },
    experienceNote: {
      type: String,
      default: null,
    },
    expertise: [{ type: String, trim: true }],
    achievements: [{ type: String, trim: true }],
    /**
     * Per-doctor in-clinic consultation fee in rupees. 0 means "use the tier
     * fee", which is how pricing worked before per-doctor overrides existed.
     */
    fee: {
      type: Number,
      default: 0,
      min: 0,
    },
    /** Links a doctor profile to their Admin login, when they have one. */
    email: {
      type: String,
      default: null,
      lowercase: true,
      trim: true,
    },
    phone: {
      type: String,
      default: null,
      trim: true,
    },
    displayOrder: {
      type: Number,
      default: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  { timestamps: true },
);

doctorSchema.index({ tier: 1, displayOrder: 1 });
doctorSchema.index({ name: 'text', expertise: 'text' });

/** Slugify a name into a doctorId — "Dr Rickson Pereira" → "rickson-pereira". */
doctorSchema.statics.slugify = function (name) {
  return String(name || '')
    .replace(/^dr\.?\s+/i, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
};

module.exports = mongoose.model('Doctor', doctorSchema);
