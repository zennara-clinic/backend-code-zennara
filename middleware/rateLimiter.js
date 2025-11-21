const rateLimit = require('express-rate-limit');

// Helper function to normalize IP address (handles IPv6)
const normalizeIp = (ip) => {
  if (!ip) return 'unknown';
  // Remove IPv6 prefix if present
  if (ip.startsWith('::ffff:')) {
    return ip.substring(7);
  }
  // For IPv6, use a hash or simplified version
  if (ip.includes(':')) {
    return ip.replace(/:/g, '-');
  }
  return ip;
};

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
  keyGenerator: (req) => {
    // Use normalized IP + email for rate limiting key
    return `${normalizeIp(req.ip)}_${req.body.email || 'unknown'}`;
  }
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
    return `${normalizeIp(req.ip)}_${req.body.email || 'unknown'}`;
  }
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
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Use admin ID for authenticated requests
    return req.admin?._id?.toString() || normalizeIp(req.ip);
  }
});
