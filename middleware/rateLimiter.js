const rateLimit = require('express-rate-limit');

// Strict rate limiter for admin login endpoints
exports.adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts per windowMs
  message: {
    success: false,
    message: 'Too many login attempts. Please try again after 15 minutes.',
    code: 'RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false // Count all requests
});

// OTP verification rate limiter
exports.adminOTPLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 10, // 10 OTP attempts per windowMs
  message: {
    success: false,
    message: 'Too many OTP verification attempts. Please request a new OTP.',
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
