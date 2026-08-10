const mongoose = require('mongoose');

/**
 * Consultation tiers and their fees.
 *
 * The app priced consultations from a hard-coded TIERS constant, so a price
 * change needed a release. The panel edits this collection instead. A doctor
 * may override the fee on their own profile; when `Doctor.fee` is 0 the tier
 * fee here applies.
 */
const doctorTierSchema = new mongoose.Schema(
  {
    tierId: {
      type: String,
      enum: ['senior-consultant', 'consultant-dermatologist'],
      required: true,
      unique: true,
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: '',
      trim: true,
    },
    /** In-clinic consultation fee in rupees — the whole cost, no add-ons. */
    fee: {
      type: Number,
      required: true,
      min: 0,
    },
    displayOrder: {
      type: Number,
      default: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model('DoctorTier', doctorTierSchema);
