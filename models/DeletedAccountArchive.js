const mongoose = require('mongoose');

/**
 * A full snapshot of everything that belonged to a user at the moment their
 * account was deleted.
 *
 * The live collections are scrubbed of the person (the app and the panel can
 * no longer see them), but this record keeps the original documents so the
 * clinic can bring the account back exactly as it was — see
 * `services/accountDeletionService.js` `restoreAccount()`.
 *
 * Only staff can read this collection. It is never exposed to the app.
 */
const deletedAccountArchiveSchema = new mongoose.Schema(
  {
    // Denormalised for lookup without opening the snapshot.
    originalUserId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    email: { type: String, index: true },
    phone: { type: String, index: true },
    fullName: { type: String },
    patientId: { type: String },

    deletedAt: { type: Date, default: Date.now, index: true },
    /** 'user' when the person did it from the app, 'admin' when staff did. */
    deletedBy: { type: String, enum: ['user', 'admin'], default: 'user' },
    deletedByAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    reason: { type: String, default: '' },

    /**
     * The snapshot, keyed by collection name → array of original documents
     * (`users` holds exactly one). Stored as Mixed so a schema change later
     * never makes an old archive unreadable.
     */
    snapshot: { type: mongoose.Schema.Types.Mixed, required: true },
    /** Per-collection counts, so the list view can say "14 bookings" cheaply. */
    counts: { type: mongoose.Schema.Types.Mixed, default: {} },

    restoredAt: { type: Date, default: null },
    restoredByAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  },
  { timestamps: true, minimize: false }
);

deletedAccountArchiveSchema.index({ restoredAt: 1, deletedAt: -1 });

module.exports = mongoose.model('DeletedAccountArchive', deletedAccountArchiveSchema);
