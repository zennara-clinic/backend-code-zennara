const { body, param, query, validationResult } = require('express-validator');
const logger = require('../utils/logger');

/**
 * Validation error handler middleware
 * Must be used after validation chains
 */
exports.handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  
  if (!errors.isEmpty()) {
    logger.security('Input validation failed', {
      ip: req.ip,
      path: req.path,
      errors: errors.array(),
      body: logger.sanitize(req.body)
    });
    
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: errors.array().map(err => ({
        field: err.param,
        message: err.msg
      }))
    });
  }
  
  next();
};

/**
 * Auth route validations
 */
exports.validateSignup = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email'),
  
  body('fullName')
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage('Full name must be between 2 and 100 characters')
    .matches(/^[a-zA-Z\s.'-]+$/)
    .withMessage('Full name contains invalid characters'),
  
  body('phone')
    .matches(/^\d{10}$/)
    .withMessage('Phone number must be exactly 10 digits'),
  
  body('location')
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage('Location must be between 2 and 100 characters'),
  
  body('dateOfBirth')
    .custom((value) => {
      if (!value) {
        throw new Error('Date of birth is required');
      }
      // Accept multiple date formats: ISO8601, DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD
      const datePatterns = [
        /^\d{4}-\d{2}-\d{2}$/,           // YYYY-MM-DD (ISO)
        /^\d{2}\/\d{2}\/\d{4}$/,         // DD/MM/YYYY or MM/DD/YYYY
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/ // ISO8601 with time
      ];
      const isValidFormat = datePatterns.some(pattern => pattern.test(value));
      if (!isValidFormat) {
        throw new Error('Please provide a valid date of birth');
      }
      return true;
    }),
  
  body('gender')
    .isIn(['Male', 'Female', 'Other', 'Prefer not to say'])
    .withMessage('Please select a valid gender'),
  
  body('privacyPolicyAccepted')
    .custom((value) => {
      // Accept both boolean true and string 'true'
      return value === true || value === 'true';
    })
    .withMessage('You must accept the Privacy Policy'),
  
  body('termsAccepted')
    .custom((value) => {
      // Accept both boolean true and string 'true'
      return value === true || value === 'true';
    })
    .withMessage('You must accept the Terms of Service'),
  
  exports.handleValidationErrors
];

exports.validateLogin = [
  body('phone')
    .matches(/^\d{10}$/)
    .withMessage('Phone number must be exactly 10 digits'),
  
  exports.handleValidationErrors
];

exports.validateVerifyOTP = [
  body('phone')
    .matches(/^\d{10}$/)
    .withMessage('Phone number must be exactly 10 digits'),
  
  body('otp')
    .isString()
    .isLength({ min: 4, max: 4 })
    .withMessage('OTP must be exactly 4 digits'),
  
  exports.handleValidationErrors
];

exports.validateUpdateProfile = [
  body('fullName')
    .optional()
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage('Full name must be between 2 and 100 characters')
    .matches(/^[a-zA-Z\s.'-]+$/)
    .withMessage('Full name contains invalid characters'),
  
  body('phone')
    .optional()
    .matches(/^\d{10}$/)
    .withMessage('Phone number must be exactly 10 digits'),
  
  body('location')
    .optional()
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage('Location must be between 2 and 100 characters'),
  
  body('dateOfBirth')
    .optional()
    .custom((value) => {
      if (!value) return true;
      // Accept multiple date formats: ISO8601, DD/MM/YYYY, MM/DD/YYYY, YYYY-MM-DD
      const datePatterns = [
        /^\d{4}-\d{2}-\d{2}$/,           // YYYY-MM-DD (ISO)
        /^\d{2}\/\d{2}\/\d{4}$/,         // DD/MM/YYYY or MM/DD/YYYY
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/ // ISO8601 with time
      ];
      const isValidFormat = datePatterns.some(pattern => pattern.test(value));
      if (!isValidFormat) {
        throw new Error('Please provide a valid date of birth');
      }
      return true;
    }),
  
  body('gender')
    .optional()
    .isIn(['Male', 'Female', 'Other', 'Prefer not to say'])
    .withMessage('Please select a valid gender'),
  
  // Prevent mass assignment - only allow specific fields
  body()
    .custom((value, { req }) => {
      const allowedFields = [
        'fullName', 'phone', 'location', 'dateOfBirth', 'gender',
        'medicalHistory', 'drugAllergies', 'dietaryPreferences',
        'smoking', 'drinking', 'additionalInfo'
      ];
      
      const extraFields = Object.keys(req.body).filter(
        key => !allowedFields.includes(key)
      );
      
      if (extraFields.length > 0) {
        throw new Error(`Unauthorized fields: ${extraFields.join(', ')}`);
      }
      
      return true;
    }),
  
  exports.handleValidationErrors
];

/**
 * Product Order Validations
 */
exports.validateOrderId = [
  param('id')
    .isMongoId()
    .withMessage('Invalid order ID'),
  
  exports.handleValidationErrors
];

/**
 * Booking Validations
 */
exports.validateBookingId = [
  param('id')
    .isMongoId()
    .withMessage('Invalid booking ID'),
  
  exports.handleValidationErrors
];

/**
 * Admin Auth Validations
 */
exports.validateAdminLogin = [
  body('username')
    .trim()
    .isLength({ min: 3, max: 50 })
    .withMessage('Username must be between 3 and 50 characters'),
  
  body('password')
    .isLength({ min: 6 })
    .withMessage('Password must be at least 6 characters'),
  
  exports.handleValidationErrors
];

/**
 * Generic MongoDB ID validation
 */
exports.validateMongoId = (paramName = 'id') => [
  param(paramName)
    .isMongoId()
    .withMessage(`Invalid ${paramName}`),
  
  exports.handleValidationErrors
];

/**
 * Pagination validation
 */
exports.validatePagination = [
  query('page')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Page must be a positive integer'),
  
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('Limit must be between 1 and 100'),
  
  exports.handleValidationErrors
];

/**
 * Order status validation
 */
exports.validateOrderStatus = [
  body('status')
    .isIn([
      'Pending',
      'Processing',
      'Packed',
      'Shipped',
      'Out for Delivery',
      'Delivered',
      'Cancelled',
      'Return Requested',
      'Return Approved',
      'Return Rejected',
      'Returned'
    ])
    .withMessage('Invalid order status'),
  
  exports.handleValidationErrors
];

/**
 * Sanitize input to prevent XSS
 */
exports.sanitizeInputs = (req, res, next) => {
  // This is already handled by helmet and express-mongo-sanitize
  // But we can add additional custom sanitization here if needed
  next();
};
