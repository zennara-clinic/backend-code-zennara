const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

/* ---------------------------------------------------------------------------
 * Is the staff login limiter paused right now?
 *
 * express-rate-limit's `skip` runs on every request and must be synchronous,
 * so the pause is held in memory and refreshed rather than read from Mongo per
 * request. `refreshLoginRateLimitPause()` is called at boot and whenever a
 * super admin changes it, and a 60-second ceiling means a pause that expires
 * (or is set by another process) is picked up without a restart.
 * ------------------------------------------------------------------------- */
let pausedUntil = null;
let lastRefresh = 0;

/** Called by the settings controller the moment the pause changes. */
exports.setLoginRateLimitPause = (until) => {
  pausedUntil = until ? new Date(until) : null;
  lastRefresh = Date.now();
};

exports.refreshLoginRateLimitPause = async () => {
  try {
    const doc = await require('../models/SecuritySettings').load();
    pausedUntil = doc?.loginRateLimit?.pausedUntil ? new Date(doc.loginRateLimit.pausedUntil) : null;
  } catch {
    // A database hiccup must never accidentally DISABLE the limiter.
    pausedUntil = null;
  }
  lastRefresh = Date.now();
};

const loginLimiterPaused = () => {
  if (Date.now() - lastRefresh > 60 * 1000) {
    lastRefresh = Date.now();
    exports.refreshLoginRateLimitPause().catch(() => {});
  }
  return Boolean(pausedUntil && pausedUntil.getTime() > Date.now());
};
exports.isLoginRateLimitPaused = loginLimiterPaused;

/**
 * One account's sign-in attempts, not one office's.
 *
 * Keying on IP alone meant a whole clinic behind one connection shared a single
 * budget — one person fat-fingering their password locked out the front desk.
 * The email is what an attacker has to guess, so it belongs in the key.
 * `ipKeyGenerator` normalises IPv6 into a /64 block; using `req.ip` raw lets an
 * attacker walk addresses within their own prefix.
 */
const perAccountKey = (req) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  return `${ipKeyGenerator(req.ip)}:${email || 'anonymous'}`;
};

/**
 * Staff sign-in. Counts FAILURES only.
 *
 * It used to count every request, including successful ones, across five
 * endpoints — and the panel spends two of them per attempt (`check-email` to
 * decide whether to show a password box, then `login-password`). Three
 * successful sign-ins therefore hit a five-request ceiling and locked the user
 * out of their own panel. A login limiter exists to stop guessing; a success is
 * not a guess.
 */
exports.adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: perAccountKey,
  skip: loginLimiterPaused,
  skipSuccessfulRequests: true,
  message: {
    success: false,
    message: 'Too many failed sign-in attempts. Please try again in 15 minutes.',
    code: 'RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * "Does this address have a panel account?" — a lookup, not an attempt.
 *
 * The panel calls it before every sign-in, so charging it to the login budget
 * halved that budget. It still needs a ceiling of its own: unthrottled, it
 * enumerates which addresses are staff.
 */
exports.adminEmailLookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  keyGenerator: perAccountKey,
  skip: loginLimiterPaused,
  message: {
    success: false,
    message: 'Too many attempts. Please try again in a few minutes.',
    code: 'RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// OTP verification rate limiter — failures only, for the same reason.
exports.adminOTPLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  keyGenerator: perAccountKey,
  skip: loginLimiterPaused,
  skipSuccessfulRequests: true,
  message: {
    success: false,
    message: 'Too many incorrect codes. Please request a new one.',
    code: 'RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false
});

// General admin API rate limiter (more lenient)
exports.adminApiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute per IP
  message: {
    success: false,
    message: 'Too many requests. Please slow down.',
    code: 'RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true // Only count failed requests
});

// Strict rate limiter for sensitive operations (delete, bulk update)
exports.adminSensitiveOperationsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // 20 sensitive operations per hour
  message: {
    success: false,
    message: 'Too many sensitive operations. Please try again later.',
    code: 'RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Prevent an authenticated client or retry loop from creating large numbers of
// abandoned gateway orders. Verification gets a higher ceiling for safe
// network retries and duplicate callbacks.
exports.paymentOrderLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  message: {
    success: false,
    message: 'Too many payment attempts. Please wait a few minutes and try again.',
    code: 'PAYMENT_RATE_LIMITED'
  },
  standardHeaders: true,
  legacyHeaders: false
});

exports.paymentVerificationLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 60,
  message: {
    success: false,
    message: 'Too many payment verification attempts. Please wait and retry.',
    code: 'PAYMENT_VERIFICATION_RATE_LIMITED'
  },
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * The walk-in tablet's OTP endpoint.
 *
 * Its per-phone cooldown stops someone re-sending to one number, but nothing
 * stopped a caller cycling through numbers — and every one of those is a
 * WhatsApp message the clinic pays for. A front desk checks in a few dozen
 * guests an hour at most, so a generous IP ceiling costs the desk nothing and
 * caps the damage.
 */
exports.walkInOtpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 40,
  message: {
    success: false,
    message: 'Too many check-ins from this device. Please wait a few minutes.',
    code: 'RATE_LIMIT_EXCEEDED',
  },
  standardHeaders: true,
  legacyHeaders: false,
});
