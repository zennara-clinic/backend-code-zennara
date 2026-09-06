const mongoose = require('mongoose');

/**
 * Time held on a provider's diary that is NOT a guest appointment.
 *
 * Zenoti calls these block-outs: "Meeting", "CRM Booking", a vendor demo, a
 * doctor holding their own afternoon. Until 2026-09-06 the appointment mirror
 * dropped them, so the slot engine happily offered that hour to an app guest,
 * while the roster import turned the placeholder guest into a patient.
 *
 * A block is therapist + range + label. It never carries a guest, is never
 * billed, and never appears in patient-facing history. The slot engine treats
 * it like a held session; the desk calendar paints it purple, as Zenoti does.
 *
 * Source 'zenoti' rows are owned by the mirror (idempotent on the Zenoti
 * appointment id). Source 'panel' rows are created from the desk calendar.
 */
const providerBlockSchema = new mongoose.Schema(
  {
    /** Zenoti appointment id of the block-out row; null for a panel block. */
    zenotiAppointmentId: { type: String, default: null, trim: true, lowercase: true },
    zenotiBlockoutId: { type: String, default: null, trim: true },
    zenotiCenterId: { type: String, default: null, trim: true, lowercase: true },
    zenotiEmployeeId: { type: String, default: null, trim: true, lowercase: true, index: true },

    /** Our dermatologist slug when the employee is an onboarded doctor. */
    doctorId: { type: String, default: null, trim: true, lowercase: true, index: true },
    /** Our therapist/admin account when the employee is a therapist. */
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    providerName: { type: String, default: '', trim: true },

    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    branchName: { type: String, default: '', trim: true },

    /** Clinic-local midnight of the day the block sits on (same convention as Booking.preferredDate). */
    date: { type: Date, required: true, index: true },
    /** "HH:mm" clinic wall clock. */
    startTime: { type: String, required: true },
    endTime: { type: String, required: true },
    startAt: { type: Date, default: null },
    endAt: { type: Date, default: null },

    /** What the block is for — Zenoti's block-out name ("Meeting", "CRM Booking"). */
    title: { type: String, default: 'Blocked', trim: true },
    notes: { type: String, default: '' },
    color: { type: String, default: null },

    source: { type: String, enum: ['zenoti', 'panel'], default: 'panel', index: true },
    createdByName: { type: String, default: null },
    createdByAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },

    /** False once the block leaves Zenoti's diary or the desk removes it. */
    active: { type: Boolean, default: true, index: true },
    zenotiSyncedAt: { type: Date, default: null },
    zenotiSource: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

providerBlockSchema.index(
  { zenotiAppointmentId: 1 },
  { unique: true, partialFilterExpression: { zenotiAppointmentId: { $type: 'string' } } },
);
providerBlockSchema.index({ doctorId: 1, date: 1, active: 1 });
providerBlockSchema.index({ branchId: 1, date: 1, active: 1 });

module.exports = mongoose.model('ProviderBlock', providerBlockSchema);
