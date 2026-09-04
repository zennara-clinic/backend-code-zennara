const mongoose = require('mongoose');

/**
 * A clinical photograph of a patient.
 *
 * Separate from every other image in the system on purpose. Product shots,
 * treatment artwork and staff portraits are marketing assets; this is patient
 * health information. It is only ever reached through an authenticated,
 * permission-gated endpoint, it is never listed in the generic media browser,
 * and deleting it is a soft delete so a clinical record is not lost to a
 * mis-click.
 *
 * The phase (before / during / after) plus `takenAt` and the appointment
 * reference are what make a chronological comparison possible — "show me this
 * patient's forehead in March, June and today" — which is the entire point of
 * photographing dermatology.
 */
const patientPhotoSchema = new mongoose.Schema(
  {
    /** Whose photograph this is. Always set. */
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    /**
     * The visit it belongs to. Optional: a follow-up photo may be taken at the
     * desk without an open appointment, and a photo must never be lost because
     * the booking it related to was cancelled.
     */
    bookingId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Booking',
      default: null,
      index: true,
    },
    /** The consultation note written at that visit, when there is one. */
    consultationNoteId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ConsultationNote',
      default: null,
      index: true,
    },
    /** The treatment plan this documents, when the photo supports one. */
    treatmentPlanId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ConsultationNote',
      default: null,
    },
    branchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Branch',
      default: null,
      index: true,
    },

    /** Where in the course of treatment this was taken. */
    phase: {
      type: String,
      enum: ['before', 'during', 'after'],
      default: 'before',
      index: true,
    },
    /** Free text: "left cheek", "hairline", "scalp vertex". */
    bodyArea: { type: String, default: '', trim: true },
    note: { type: String, default: '', trim: true, maxlength: 1000 },

    /** S3 URL written by uploadToS3. */
    url: { type: String, required: true, trim: true },
    /** Kept so the object can be removed from S3 on a hard delete. */
    storageKey: { type: String, default: null, trim: true },
    mimeType: { type: String, default: 'image/jpeg' },
    sizeBytes: { type: Number, default: 0 },

    /**
     * When the photograph was TAKEN, not when it was uploaded. A visit
     * photographed on the day and uploaded the following morning must still
     * sort into the right place in the patient's timeline.
     */
    takenAt: { type: Date, default: Date.now, index: true },

    /** The staff member who captured it, for the clinical audit trail. */
    takenBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    takenByName: { type: String, default: '', trim: true },
    takenByRole: { type: String, default: '', trim: true },

    /**
     * Soft delete. A clinical image is evidence; removing it from a view must
     * not destroy it. A hard delete is a separate, deliberate admin action.
     */
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  },
  { timestamps: true },
);

// The chronological read: one patient, newest first. Matches the only sort the
// API ever applies (see point 13 — every clinical list is newest-to-oldest).
patientPhotoSchema.index({ userId: 1, takenAt: -1 });
patientPhotoSchema.index({ userId: 1, phase: 1, takenAt: -1 });
patientPhotoSchema.index({ bookingId: 1, takenAt: -1 });

module.exports = mongoose.model('PatientPhoto', patientPhotoSchema);
