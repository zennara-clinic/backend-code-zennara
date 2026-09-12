const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

/* ---------------------------------------------------------------------------
 * The guessing budget belongs to the NUMBER, not to one code.
 *
 * `setOTP` used to zero `attempts`, and `verifyOTP` caps attempts per code — so
 * anyone who could ask for a resend could also buy themselves three fresh
 * guesses, as often as they liked, at a code short enough to enumerate. The
 * walk-in tablet's send-otp endpoint is public (curl does not care about
 * CORS), which turned that into an open door on a real guest's record.
 *
 * Both counters are therefore rolling windows kept on this record:
 *
 *   · failed guesses — MAX_ATTEMPTS_PER_WINDOW inside ATTEMPT_WINDOW_MS. A
 *     resend no longer clears them, and `canIssueOTP()` refuses to mint a new
 *     code at all while the window is exhausted.
 *   · codes sent     — MAX_SENDS_PER_WINDOW inside SEND_WINDOW_MS. Every one
 *     of those is a WhatsApp message the clinic pays Twilio for.
 *
 * One caveat, deliberately not hidden: the TTL index below deletes an
 * abandoned record an hour after its OTP expires, and that takes these
 * counters with it. The windows therefore bound a burst rather than a
 * calendar day. Making them survive a quiet hour means re-keying the TTL onto
 * a separate retention date, which is a migration on a live collection.
 * ------------------------------------------------------------------------- */
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS_PER_WINDOW = 5;
const SEND_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_SENDS_PER_WINDOW = 8;

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
  /** Failed guesses inside the current window — see the note at the top. */
  attempts: {
    type: Number,
    default: 0,
  },
  attemptsWindowStartedAt: {
    type: Date,
    default: null,
  },
  /** Codes actually sent (and paid for) inside the current send window. */
  sends: {
    type: Number,
    default: 0,
  },
  sendsWindowStartedAt: {
    type: Date,
    default: null,
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

/**
 * Start a fresh guess window if the last one has run out.
 * Returns how many guesses are left in the window that is now current.
 */
SignupVerificationSchema.methods.rollAttemptWindow = function rollAttemptWindow(now = Date.now()) {
  if (!this.attemptsWindowStartedAt || now - this.attemptsWindowStartedAt.getTime() >= ATTEMPT_WINDOW_MS) {
    this.attemptsWindowStartedAt = new Date(now);
    this.attempts = 0;
  }
  return Math.max(0, MAX_ATTEMPTS_PER_WINDOW - this.attempts);
};

/** Whole minutes until the current guess window lets this number try again. */
SignupVerificationSchema.methods.attemptsLockMinutes = function attemptsLockMinutes(now = Date.now()) {
  if (!this.attemptsWindowStartedAt) return 0;
  const left = ATTEMPT_WINDOW_MS - (now - this.attemptsWindowStartedAt.getTime());
  return Math.max(1, Math.ceil(left / 60000));
};

/**
 * May another code be sent to this number right now?
 *
 * Two independent reasons to say no: the guess window is spent (a resend must
 * not buy more guesses), or the number has already been sent its allowance of
 * paid messages.
 */
SignupVerificationSchema.methods.canIssueOTP = function canIssueOTP() {
  const now = Date.now();
  if (this.rollAttemptWindow(now) <= 0) {
    return {
      allowed: false,
      code: 'OTP_ATTEMPTS_EXCEEDED',
      message: `Too many incorrect codes for this number. Please try again in ${this.attemptsLockMinutes(now)} minute(s).`,
    };
  }
  const windowLive = this.sendsWindowStartedAt && now - this.sendsWindowStartedAt.getTime() < SEND_WINDOW_MS;
  if (windowLive && this.sends >= MAX_SENDS_PER_WINDOW) {
    return {
      allowed: false,
      code: 'OTP_SEND_LIMIT',
      message: 'This number has already been sent today\'s limit of codes. Please ask the front desk for help.',
    };
  }
  return { allowed: true };
};

/** Count a code we are about to pay to deliver. */
SignupVerificationSchema.methods.registerSend = function registerSend(now = Date.now()) {
  if (!this.sendsWindowStartedAt || now - this.sendsWindowStartedAt.getTime() >= SEND_WINDOW_MS) {
    this.sendsWindowStartedAt = new Date(now);
    this.sends = 0;
  }
  this.sends += 1;
};

SignupVerificationSchema.methods.setOTP = function setOTP(otp) {
  this.otpHash = bcrypt.hashSync(String(otp), 10);
  this.expiresAt = new Date(Date.now() + 5 * 60 * 1000);
  /*
   * `attempts` is deliberately NOT cleared here. It is the rolling per-number
   * count, and clearing it on every resend is precisely the bypass this file's
   * opening note describes; it resets only when its own window runs out.
   */
  this.rollAttemptWindow();
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
  const now = Date.now();
  if (this.rollAttemptWindow(now) <= 0) {
    return {
      success: false,
      message: `Too many incorrect codes. Please try again in ${this.attemptsLockMinutes(now)} minute(s).`,
    };
  }

  const valid = bcrypt.compareSync(String(otp).trim(), this.otpHash);
  if (!valid) {
    this.attempts += 1;
    const remaining = Math.max(0, MAX_ATTEMPTS_PER_WINDOW - this.attempts);
    return {
      success: false,
      message: remaining
        ? `Invalid OTP. ${remaining} attempt(s) remaining.`
        : `Too many incorrect codes. Please try again in ${this.attemptsLockMinutes(now)} minute(s).`,
    };
  }

  // The right code proves whoever holds the phone; the guess budget is theirs
  // again. (A wrong one never clears it — only the window does.)
  this.attempts = 0;
  this.verifiedAt = new Date();
  // Give the user enough time to complete the profile form after the OTP has
  // been accepted. This also controls how long the verification proof remains
  // consumable by /auth/signup.
  this.expiresAt = new Date(Date.now() + 20 * 60 * 1000);
  return { success: true };
};

module.exports = mongoose.model('SignupVerification', SignupVerificationSchema);
