const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

/**
 * A customer-initiated request to change their own email or phone.
 *
 * Flow (see controllers/contactChangeController.js):
 *   1. start   → OTP sent to the CURRENT contact (email→email, phone→WhatsApp)
 *   2. verify  → prove they control the current contact
 *   3. submit  → they enter the new value; we SCHEDULE the change for +N hours
 *   4. a cron (utils/contactChangeScheduler.js) applies it automatically later
 *
 * The delay is deliberate: it's a fraud/cool-off window and lets the customer
 * see a "we're processing your request" state, while the update is fully
 * automatic — no clinic staff action is ever required.
 */
const contactChangeRequestSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: ['email', 'phone'], required: true },

    // The value at request time (for audit + so the panel can show from → to).
    currentValue: { type: String, default: null },
    // The new value, captured only AFTER the current contact is verified.
    newValue: { type: String, default: null },
    // Masked destination we sent the code to, for UI display ("v•••@gmail.com").
    sentTo: { type: String, default: null },

    // OTP that verifies the CURRENT contact (hashed, never stored in clear).
    otp: { type: String, default: null },
    otpExpiry: { type: Date, default: null },
    otpAttempts: { type: Number, default: 0 },

    status: {
      type: String,
      enum: ['awaiting_verification', 'verified', 'scheduled', 'applied', 'cancelled', 'failed'],
      default: 'awaiting_verification',
      index: true,
    },
    verifiedAt: { type: Date, default: null },
    scheduledApplyAt: { type: Date, default: null, index: true },
    appliedAt: { type: Date, default: null },
    failureReason: { type: String, default: null },
  },
  { timestamps: true }
);

/** Generate + store a hashed 4-digit code (5-min expiry). Returns the plain code. */
contactChangeRequestSchema.methods.setOtp = function () {
  const otp = Math.floor(1000 + Math.random() * 9000).toString();
  this.otp = bcrypt.hashSync(otp, 10);
  this.otpExpiry = Date.now() + 5 * 60 * 1000;
  this.otpAttempts = 0;
  return otp;
};

/** Verify an entered code. Max 3 attempts per code. */
contactChangeRequestSchema.methods.checkOtp = function (entered) {
  if (!this.otp || !this.otpExpiry) {
    return { success: false, message: 'No code found. Please request a new one.' };
  }
  if (Date.now() > this.otpExpiry) {
    return { success: false, message: 'This code has expired. Please request a new one.' };
  }
  if (this.otpAttempts >= 3) {
    return { success: false, message: 'Too many attempts. Please request a new code.' };
  }
  const ok = bcrypt.compareSync(String(entered).trim(), this.otp);
  if (!ok) {
    this.otpAttempts += 1;
    const left = Math.max(0, 3 - this.otpAttempts);
    return { success: false, message: `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.` };
  }
  return { success: true };
};

contactChangeRequestSchema.methods.clearOtp = function () {
  this.otp = null;
  this.otpExpiry = null;
  this.otpAttempts = 0;
};

contactChangeRequestSchema.index({ userId: 1, status: 1 });

module.exports = mongoose.model('ContactChangeRequest', contactChangeRequestSchema);
