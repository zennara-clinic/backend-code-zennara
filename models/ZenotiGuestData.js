const mongoose = require('mongoose');

/**
 * Local mirror of one Zenoti guest's history — appointments, product purchases,
 * memberships and packages — keyed by the local User that mirrors the guest.
 *
 * Zenoti is still the system of record; this copy exists so the panel can list
 * clinic customers' packages/appointments alongside app-native data without a
 * live CRM call per row, and so the numbers stay visible when Zenoti is slow.
 * Refreshed by the background crawl (utils/zenotiScheduler.js) and on demand
 * when staff open a patient.
 */
const Mixed = mongoose.Schema.Types.Mixed;

const ZenotiGuestDataSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    zenotiGuestId: { type: String, required: true, unique: true },
    centerId: { type: String, default: null },
    branchName: { type: String, default: null },

    appointments: { type: [Mixed], default: [] },
    orders: { type: [Mixed], default: [] },
    memberships: { type: [Mixed], default: [] },
    packages: { type: [Mixed], default: [] },

    // Derived counters so lists can sort/filter without unwinding.
    stats: {
      treatmentsDone: { type: Number, default: 0 },
      upcoming: { type: Number, default: 0 },
      productsBought: { type: Number, default: 0 },
      activePackages: { type: Number, default: 0 },
      sessionsLeft: { type: Number, default: 0 },
      activeMemberships: { type: Number, default: 0 },
      lifetimeSpend: { type: Number, default: 0 },
      lastVisit: { type: Date, default: null },
      nextVisit: { type: Date, default: null },
    },

    syncedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
  },
  { timestamps: true }
);

ZenotiGuestDataSchema.index({ syncedAt: 1 });
ZenotiGuestDataSchema.index({ branchName: 1, 'stats.lastVisit': -1 });

module.exports = mongoose.model('ZenotiGuestData', ZenotiGuestDataSchema);
