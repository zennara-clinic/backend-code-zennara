const mongoSanitize = require('express-mongo-sanitize');
const xss = require('xss-clean');
const validator = require('validator');

// MongoDB injection protection middleware
exports.mongoSanitizer = mongoSanitize({
  replaceWith: '_', // Replace prohibited characters with underscore
  onSanitize: ({ req, key }) => {
    console.warn(`⚠️ Sanitized potentially malicious input in ${key}`);
  }
});

// XSS protection middleware
exports.xssProtection = xss();

// Validate and sanitize MongoDB ObjectId
exports.validateObjectId = (paramName = 'id') => {
  return (req, res, next) => {
    const id = req.params[paramName];
    
    if (!id) {
      return res.status(400).json({
        success: false,
        message: `${paramName} is required`
      });
    }
    
    // Check if it's a valid MongoDB ObjectId (24 hex characters)
    const objectIdRegex = /^[0-9a-fA-F]{24}$/;
    if (!objectIdRegex.test(id)) {
      return res.status(400).json({
        success: false,
        message: `Invalid ${paramName} format`
      });
    }
    
    next();
  };
};

// Validate email format
exports.validateEmail = (req, res, next) => {
  const email = req.body.email;
  
  if (email && !validator.isEmail(email)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid email format'
    });
  }
  
  next();
};

// Validate phone number format (10 digits)
exports.validatePhone = (req, res, next) => {
  const phone = req.body.phone;
  
  if (phone) {
    // Remove any non-digit characters
    const cleanPhone = phone.replace(/\D/g, '');
    
    if (cleanPhone.length !== 10) {
      return res.status(400).json({
        success: false,
        message: 'Phone number must be 10 digits'
      });
    }
    
    // Update with cleaned phone
    req.body.phone = cleanPhone;
  }
  
  next();
};

// Sanitize string inputs (remove HTML, scripts, etc.)
exports.sanitizeStrings = (req, res, next) => {
  const sanitize = (obj) => {
    for (let key in obj) {
      if (typeof obj[key] === 'string') {
        // Remove HTML tags and sanitize
        obj[key] = validator.stripLow(obj[key]);
        obj[key] = validator.trim(obj[key]);
        // Escape HTML to prevent XSS
        obj[key] = validator.escape(obj[key]);
      } else if (typeof obj[key] === 'object' && obj[key] !== null) {
        sanitize(obj[key]);
      }
    }
  };
  
  if (req.body) {
    sanitize(req.body);
  }
  
  next();
};

// Validate request body size
exports.validateBodySize = (maxSizeKB = 100) => {
  return (req, res, next) => {
    const contentLength = parseInt(req.headers['content-length']) || 0;
    const maxSizeBytes = maxSizeKB * 1024;
    
    if (contentLength > maxSizeBytes) {
      return res.status(413).json({
        success: false,
        message: `Request body too large. Maximum ${maxSizeKB}KB allowed.`
      });
    }
    
    next();
  };
};

// Prevent parameter pollution
exports.preventParameterPollution = (whitelist = []) => {
  return (req, res, next) => {
    // Check for duplicate parameters
    for (let key in req.query) {
      if (Array.isArray(req.query[key]) && !whitelist.includes(key)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid parameters detected'
        });
      }
    }
    next();
  };
};
