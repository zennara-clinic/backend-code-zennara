const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const SignupVerificationSchema = new mongoose.Schema({
  phone: {
    type: String,
    required: true,
    unique: true,
  },
  otpHash: {
    type: String,
    required: true,
  },
  expiresAt: {
    type: Date,
    required: true,
  },
  attempts: {
    type: Number,
    default: 0,
  },
  verifiedAt: {
    type: Date,
    default: null,
  },
  usedAt: {
    type: Date,
    default: null,
  },
}, { timestamps: true });

// Remove abandoned verification records automatically after they are no
// longer useful. MongoDB's TTL worker is asynchronous, so controllers still
// check expiresAt explicitly.
SignupVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });

SignupVerificationSchema.methods.setOTP = function setOTP(otp) {
  this.otpHash = bcrypt.hashSync(String(otp), 10);
  this.expiresAt = new Date(Date.now() + 5 * 60 * 1000);
  this.attempts = 0;
  this.verifiedAt = null;
  this.usedAt = null;
};

SignupVerificationSchema.methods.verifyOTP = function verifyOTP(otp) {
  if (this.usedAt) {
    return { success: false, message: 'This verification has already been used.' };
  }
  if (this.expiresAt <= new Date()) {
    return { success: false, message: 'OTP has expired. Please request a new one.' };
  }
  if (this.attempts >= 3) {
    return { success: false, message: 'Maximum attempts exceeded. Please request a new OTP.' };
  }

  const valid = bcrypt.compareSync(String(otp).trim(), this.otpHash);
  if (!valid) {
    this.attempts += 1;
    return {
      success: false,
      message: `Invalid OTP. ${Math.max(0, 3 - this.attempts)} attempt(s) remaining.`,
    };
  }

  this.verifiedAt = new Date();
  // Give the user enough time to complete the profile form after the OTP has
  // been accepted. This also controls how long the verification proof remains
  // consumable by /auth/signup.
  this.expiresAt = new Date(Date.now() + 20 * 60 * 1000);
  return { success: true };
};

module.exports = mongoose.model('SignupVerification', SignupVerificationSchema);
