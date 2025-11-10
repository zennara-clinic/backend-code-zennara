const rateLimit = require('express-rate-limit');

// General API rate limiter - prevents brute force attacks
exports.apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: {
    success: false,
    message: 'Too many requests from this IP, please try again later.',
    retryAfter: '15 minutes'
  },
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  // Skip successful requests (only count failed ones)
  skipSuccessfulRequests: false,
  // Skip failed requests (don't count them against limit)
  skipFailedRequests: false,
  handler: (req, res) => {
    console.warn(`⚠️ Rate limit exceeded for IP: ${req.ip}`);
    res.status(429).json({
      success: false,
      message: 'Too many requests. Please try again later.',
      retryAfter: '15 minutes'
    });
  }
});

// Strict limiter for authentication endpoints - prevents credential stuffing
exports.authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 login attempts per 15 minutes
  message: {
    success: false,
    message: 'Too many login attempts. Please try again in 15 minutes.',
    code: 'RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // Don't count successful logins
  handler: (req, res) => {
    console.warn(`🔒 Auth rate limit exceeded for IP: ${req.ip}`);
    res.status(429).json({
      success: false,
      message: 'Too many login attempts. Account temporarily locked.',
      code: 'RATE_LIMIT_EXCEEDED',
      retryAfter: '15 minutes'
    });
  }
});

// OTP request limiter - prevents OTP spam
exports.otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 3, // Max 3 OTP requests per 10 minutes
  message: {
    success: false,
    message: 'Too many OTP requests. Please wait 10 minutes.',
    code: 'OTP_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.warn(`📧 OTP rate limit exceeded for IP: ${req.ip}`);
    res.status(429).json({
      success: false,
      message: 'Too many OTP requests. Please try again later.',
      code: 'OTP_LIMIT_EXCEEDED',
      retryAfter: '10 minutes'
    });
  }
});

// Payment limiter - prevents payment spam/testing
exports.paymentLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // Max 10 payment attempts per hour
  message: {
    success: false,
    message: 'Too many payment attempts. Please try again later.',
    code: 'PAYMENT_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.warn(`💳 Payment rate limit exceeded for IP: ${req.ip}`);
    res.status(429).json({
      success: false,
      message: 'Too many payment attempts. Please contact support.',
      code: 'PAYMENT_LIMIT_EXCEEDED'
    });
  }
});

// Order creation limiter - prevents order spam
exports.orderLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // Max 20 orders per hour
  message: {
    success: false,
    message: 'Too many orders. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.warn(`🛒 Order rate limit exceeded for IP: ${req.ip}`);
    res.status(429).json({
      success: false,
      message: 'Order limit reached. Please try again later.'
    });
  }
});

// Admin limiter - stricter for admin endpoints
exports.adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // Lower limit for admin operations
  message: {
    success: false,
    message: 'Too many admin requests.'
  },
  standardHeaders: true,
  legacyHeaders: false
});
