const mongoose = require('mongoose');

/**
 * A doctor's request to change their own consultation fee.
 *
 * Doctors never set their own price. The clinic sets a standard fee per tier
 * (`DoctorTier.fee`); a doctor who wants to charge differently raises a request
 * here, and an admin decides. Only an approved request writes `Doctor.fee`,
 * which is the per-doctor override the booking flow then charges.
 *
 * The admin may approve the amount the doctor asked for, or approve a different
 * one — so `approvedFee` is recorded separately from `requestedFee` and the
 * history shows both.
 */
const doctorFeeRequestSchema = new mongoose.Schema(
  {
    /** Slug from the Doctor collection, e.g. "rickson-pereira". */
    doctorId: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    doctorName: {
      type: String,
      required: true,
      trim: true,
    },
    /** The Admin account that raised it (the doctor's own login). */
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null,
    },
    requestedByEmail: {
      type: String,
      default: null,
    },

    /** What the doctor was effectively charging when they asked. */
    currentFee: {
      type: Number,
      required: true,
      min: 0,
    },
    /** True when currentFee came from the tier rather than a personal override. */
    currentFeeWasTierFee: {
      type: Boolean,
      default: true,
    },
    requestedFee: {
      type: Number,
      required: [true, 'A requested fee is required'],
      min: [0, 'A fee cannot be negative'],
    },
    reason: {
      type: String,
      required: [true, 'A reason is required — the admin reviews it'],
      trim: true,
      minlength: [10, 'Please give the admin a bit more detail (10 characters or more)'],
      maxlength: 1000,
    },

    status: {
      type: String,
      enum: ['Pending', 'Approved', 'Rejected', 'Withdrawn'],
      default: 'Pending',
      index: true,
    },

    /** Set on approval. May differ from requestedFee if the admin adjusted it. */
    approvedFee: {
      type: Number,
      default: null,
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null,
    },
    reviewedByEmail: {
      type: String,
      default: null,
    },
    reviewNote: {
      type: String,
      default: null,
      trim: true,
      maxlength: 1000,
    },
    decidedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

doctorFeeRequestSchema.index({ status: 1, createdAt: -1 });
doctorFeeRequestSchema.index({ doctorId: 1, createdAt: -1 });

/** A doctor may only have one request in flight at a time. */
doctorFeeRequestSchema.statics.pendingFor = function (doctorId) {
  return this.findOne({ doctorId: String(doctorId).toLowerCase(), status: 'Pending' });
};

module.exports = mongoose.model('DoctorFeeRequest', doctorFeeRequestSchema);
