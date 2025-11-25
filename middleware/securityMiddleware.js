const logger = require('../utils/logger');

/**
 * Field whitelisting utility to prevent mass assignment
 * @param {Object} body - Request body
 * @param {Array} allowedFields - Array of allowed field names
 * @returns {Object} Filtered object with only allowed fields
 */
exports.filterFields = (body, allowedFields) => {
  const filtered = {};
  allowedFields.forEach(field => {
    if (body[field] !== undefined) {
      filtered[field] = body[field];
    }
  });
  return filtered;
};

/**
 * Validate resource ownership
 * @param {Object} resource - Database resource
 * @param {String} userId - User ID to validate against
 * @param {String} ownerField - Field name that contains owner ID (default: 'userId')
 * @returns {Boolean} True if user owns resource
 */
exports.validateOwnership = (resource, userId, ownerField = 'userId') => {
  if (!resource) return false;
  const resourceOwnerId = resource[ownerField];
  if (!resourceOwnerId) return false;
  return resourceOwnerId.toString() === userId.toString();
};

/**
 * CSRF Token Generator (Custom implementation)
 * Since csurf is deprecated, we'll use a custom token approach
 */
const crypto = require('crypto');

const csrfTokens = new Map();

// Generate CSRF token
exports.generateCSRFToken = (userId) => {
  const token = crypto.randomBytes(32).toString('hex');
  csrfTokens.set(userId, {
    token,
    createdAt: Date.now()
  });
  
  // Clean up old tokens (older than 1 hour)
  setTimeout(() => {
    const now = Date.now();
    for (const [key, value] of csrfTokens.entries()) {
      if (now - value.createdAt > 3600000) {
        csrfTokens.delete(key);
      }
    }
  }, 3600000);
  
  return token;
};

// Verify CSRF token
exports.verifyCSRFToken = (userId, token) => {
  const stored = csrfTokens.get(userId);
  if (!stored) return false;
  
  // Check if token is expired (1 hour)
  if (Date.now() - stored.createdAt > 3600000) {
    csrfTokens.delete(userId);
    return false;
  }
  
  return stored.token === token;
};

// CSRF Protection Middleware
exports.csrfProtection = (req, res, next) => {
  // Skip CSRF check for GET, HEAD, OPTIONS
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }
  
  // Skip for non-admin routes in this implementation
  // You can customize this based on your needs
  if (!req.path.includes('/admin/')) {
    return next();
  }
  
  const token = req.headers['x-csrf-token'];
  const userId = req.user?._id || req.admin?._id;
  
  if (!userId) {
    logger.security('CSRF check failed - no user', { 
      path: req.path, 
      ip: req.ip 
    });
    return res.status(401).json({ 
      success: false, 
      message: 'Authentication required' 
    });
  }
  
  if (!token || !exports.verifyCSRFToken(userId.toString(), token)) {
    logger.security('CSRF token validation failed', { 
      userId, 
      path: req.path, 
      ip: req.ip 
    });
    return res.status(403).json({ 
      success: false, 
      message: 'Invalid CSRF token' 
    });
  }
  
  next();
};

/**
 * Input sanitization helper
 * Strips dangerous characters and patterns
 */
exports.sanitizeInput = (input) => {
  if (typeof input !== 'string') return input;
  
  // Remove potential XSS patterns
  return input
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+\s*=/gi, '')
    .trim();
};

/**
 * Rate limit key generator
 * Uses user ID if authenticated, otherwise IP
 */
exports.getRateLimitKey = (req) => {
  return req.user?._id || req.admin?._id || req.ip;
};

/**
 * Security headers middleware (backup to helmet)
 */
exports.securityHeaders = (req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
};

/**
 * Request validation logger
 * Logs suspicious patterns for security monitoring
 */
exports.logSuspiciousActivity = (req, res, next) => {
  const suspiciousPatterns = [
    /\$where/i,
    /\$regex/i,
    /\$ne/i,
    /\$gt/i,
    /\$lt/i,
    /<script/i,
    /javascript:/i,
    /onerror=/i,
    /onclick=/i
  ];
  
  const bodyStr = JSON.stringify(req.body);
  const queryStr = JSON.stringify(req.query);
  
  const isSuspicious = suspiciousPatterns.some(pattern => 
    pattern.test(bodyStr) || pattern.test(queryStr)
  );
  
  if (isSuspicious) {
    logger.security('Suspicious input detected', {
      ip: req.ip,
      path: req.path,
      method: req.method,
      userAgent: req.headers['user-agent'],
      body: logger.sanitize(req.body),
      query: req.query
    });
  }
  
  next();
};
