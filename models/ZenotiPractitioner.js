const mongoose = require('mongoose');

/**
 * A reporting-only mirror of Zenoti employees whose Zenoti job is Doctor.
 *
 * This collection must never be used as the public app roster. A practitioner
 * appears in the app only after a real `Doctor` profile is created through the
 * normal onboarding flow. `onboardedDoctorId` merely links the two identities
 * for reporting and prevents duplicate rows in filters/analytics.
 */
const zenotiPractitionerSchema = new mongoose.Schema({
  zenotiEmployeeId: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
  name: { type: String, required: true, trim: true },
  normalizedName: { type: String, required: true, lowercase: true, trim: true, index: true },
  jobName: { type: String, default: 'Doctor', trim: true },
  centerIds: [{ type: String, lowercase: true, trim: true }],
  centerNames: [{ type: String, trim: true }],
  onboardedDoctorId: { type: String, lowercase: true, trim: true, default: null, index: true },
  active: { type: Boolean, default: true, index: true },
  lastSeenAt: { type: Date, default: Date.now },
  syncedAt: { type: Date, default: Date.now },
}, { timestamps: true });

zenotiPractitionerSchema.index({ active: 1, name: 1 });

module.exports = mongoose.model('ZenotiPractitioner', zenotiPractitionerSchema);
