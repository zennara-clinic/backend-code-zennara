const mongoose = require('mongoose');

/**
 * Org-wide security switches. One document, id `security`.
 *
 * Only one thing lives here so far: the ability to pause the staff login rate
 * limiter. It exists because testing a panel legitimately means signing in over
 * and over, and there was no way to do that without waiting out a 15-minute
 * window.
 *
 * The pause is deliberately NOT a boolean. Brute-force protection that can be
 * switched off indefinitely is protection that will eventually be found off,
 * months later, by nobody in particular. "Off" here is always "off until a
 * timestamp", capped at 24 hours — a testing window that closes itself.
 */
const securitySettingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: 'security' },

    loginRateLimit: {
      /**
       * When the pause expires. Null (or in the past) means the limiter is on.
       * There is no `enabled: false` — see above.
       */
      pausedUntil: { type: Date, default: null },
      pausedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
      pausedByName: { type: String, default: null, trim: true },
      /** Why it was paused. Required, so the audit trail reads as a sentence. */
      pausedReason: { type: String, default: null, trim: true, maxlength: 200 },
    },
  },
  { timestamps: true, versionKey: false },
);

/** The longest a pause may last. A window, never a setting. */
securitySettingsSchema.statics.MAX_PAUSE_MINUTES = 24 * 60;

securitySettingsSchema.statics.load = async function load() {
  return this.findByIdAndUpdate(
    'security',
    { $setOnInsert: { _id: 'security' } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
};

module.exports = mongoose.model('SecuritySettings', securitySettingsSchema);
