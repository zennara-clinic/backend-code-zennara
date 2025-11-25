const winston = require('winston');
const path = require('path');

// Define log format
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

// Define console format for development
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : '';
    return `${timestamp} [${level}]: ${message} ${metaStr}`;
  })
);

// Create logger instance
const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: logFormat,
  transports: [
    // Write all logs to combined.log
    new winston.transports.File({ 
      filename: path.join(__dirname, '../logs/combined.log'),
      maxsize: 10485760, // 10MB
      maxFiles: 5
    }),
    // Write errors to error.log
    new winston.transports.File({ 
      filename: path.join(__dirname, '../logs/error.log'),
      level: 'error',
      maxsize: 10485760, // 10MB
      maxFiles: 5
    }),
    // Write security events to security.log
    new winston.transports.File({ 
      filename: path.join(__dirname, '../logs/security.log'),
      level: 'warn',
      maxsize: 10485760, // 10MB
      maxFiles: 10
    })
  ],
  // Handle exceptions
  exceptionHandlers: [
    new winston.transports.File({ 
      filename: path.join(__dirname, '../logs/exceptions.log'),
      maxsize: 10485760,
      maxFiles: 5
    })
  ],
  // Handle rejections
  rejectionHandlers: [
    new winston.transports.File({ 
      filename: path.join(__dirname, '../logs/rejections.log'),
      maxsize: 10485760,
      maxFiles: 5
    })
  ]
});

// If not in production, also log to console
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: consoleFormat
  }));
}

// Sanitize sensitive data from logs
function sanitizeLogData(data) {
  if (!data || typeof data !== 'object') return data;
  
  const sanitized = { ...data };
  const sensitiveFields = [
    'password', 'otp', 'token', 'refreshToken', 
    'apiKey', 'secret', 'creditCard', 'ssn',
    'accountNumber', 'ifscCode', 'cvv', 'pin'
  ];
  
  sensitiveFields.forEach(field => {
    if (sanitized[field]) {
      sanitized[field] = '[REDACTED]';
    }
  });
  
  return sanitized;
}

// Security event logger
logger.security = (event, data = {}) => {
  logger.warn('SECURITY_EVENT', {
    event,
    data: sanitizeLogData(data),
    timestamp: new Date().toISOString()
  });
};

// Export sanitize function
logger.sanitize = sanitizeLogData;

module.exports = logger;
