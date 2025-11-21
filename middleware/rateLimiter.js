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
  skipSuccessfulRequests: false, // Count all requests
  skip: () => false, // Don't skip any requests
  keyGenerator: (req) => {
    // Use IP + email for rate limiting key
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    return `${ip}_${req.body.email || 'unknown'}`;
  },
  validate: { ipv6: false } // Disable IPv6 validation
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
  legacyHeaders: false,
  keyGenerator: (req) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    return `${ip}_${req.body.email || 'unknown'}`;
  },
  validate: { ipv6: false } // Disable IPv6 validation
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
  skipSuccessfulRequests: true, // Only count failed requests
  validate: { ipv6: false } // Disable IPv6 validation
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
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Use admin ID for authenticated requests
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    return req.admin?._id?.toString() || ip;
  },
  validate: { ipv6: false } // Disable IPv6 validation
});
