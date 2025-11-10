const Admin = require('../models/Admin');

// IP Whitelist middleware for admin routes
exports.adminIPWhitelist = (req, res, next) => {
  const clientIP = req.ip || req.connection.remoteAddress;
  
  // Get allowed IPs from environment variable
  const allowedIPs = process.env.ADMIN_IP_WHITELIST 
    ? process.env.ADMIN_IP_WHITELIST.split(',').map(ip => ip.trim())
    : [];
  
  // If whitelist is configured and IP is not in the list
  if (allowedIPs.length > 0 && !allowedIPs.includes(clientIP)) {
    console.error('🚫 BLOCKED: Unauthorized admin IP access:', {
      ip: clientIP,
      url: req.url,
      method: req.method,
      timestamp: new Date().toISOString()
    });
    
    return res.status(403).json({
      success: false,
      message: 'Access forbidden. Your IP is not authorized.'
    });
  }
  
  next();
};

// Admin activity logger
exports.logAdminActivity = async (req, res, next) => {
  try {
    const admin = req.admin;
    
    if (!admin) {
      return next();
    }
    
    // Log the activity (you can store this in database if needed)
    const activityLog = {
      adminId: admin._id,
      adminEmail: admin.email,
      action: `${req.method} ${req.path}`,
      ip: admin.ip,
      userAgent: admin.userAgent,
      timestamp: new Date(),
      requestBody: req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' 
        ? sanitizeLogData(req.body) 
        : undefined
    };
    
    console.log('📝 Admin Activity:', activityLog);
    
    // TODO: Optionally save to database for audit trail
    // await AdminActivityLog.create(activityLog);
    
    next();
  } catch (error) {
    console.error('Error logging admin activity:', error);
    next(); // Don't block the request if logging fails
  }
};

// Sanitize sensitive data before logging
function sanitizeLogData(data) {
  if (!data) return data;
  
  const sanitized = { ...data };
  const sensitiveFields = ['password', 'otp', 'token', 'secret', 'key'];
  
  for (const field of sensitiveFields) {
    if (sanitized[field]) {
      sanitized[field] = '[REDACTED]';
    }
  }
  
  return sanitized;
}

// Role-based access control middleware
exports.requireAdminRole = (allowedRoles = []) => {
  return (req, res, next) => {
    const admin = req.admin;
    
    if (!admin) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }
    
    // If no specific roles required, any admin can access
    if (allowedRoles.length === 0) {
      return next();
    }
    
    // Check if admin has required role
    if (!allowedRoles.includes(admin.role)) {
      console.warn('⚠️ Insufficient permissions:', {
        adminId: admin._id,
        adminRole: admin.role,
        requiredRoles: allowedRoles,
        url: req.url
      });
      
      return res.status(403).json({
        success: false,
        message: 'Insufficient permissions. Higher admin role required.'
      });
    }
    
    next();
  };
};

// Prevent brute force on admin login
let loginAttempts = new Map(); // In production, use Redis or database

exports.preventAdminBruteForce = (req, res, next) => {
  const email = req.body.email?.toLowerCase();
  const clientIP = req.ip || req.connection.remoteAddress;
  const key = `${email}_${clientIP}`;
  
  if (!email) {
    return next();
  }
  
  const now = Date.now();
  const attempts = loginAttempts.get(key) || { count: 0, firstAttempt: now };
  
  // Reset after 15 minutes
  if (now - attempts.firstAttempt > 15 * 60 * 1000) {
    loginAttempts.delete(key);
    return next();
  }
  
  // Block after 5 failed attempts
  if (attempts.count >= 5) {
    const timeLeft = Math.ceil((15 * 60 * 1000 - (now - attempts.firstAttempt)) / 60000);
    
    console.error('🔒 BLOCKED: Admin brute force attempt:', {
      email,
      ip: clientIP,
      attempts: attempts.count,
      timeLeft: `${timeLeft} minutes`
    });
    
    return res.status(429).json({
      success: false,
      message: `Too many login attempts. Account locked for ${timeLeft} minutes.`,
      code: 'ACCOUNT_LOCKED'
    });
  }
  
  // Store attempt
  req.trackLoginAttempt = (failed) => {
    if (failed) {
      attempts.count++;
      loginAttempts.set(key, attempts);
    } else {
      // Clear on successful login
      loginAttempts.delete(key);
    }
  };
  
  next();
};

// Admin session validation
exports.validateAdminSession = async (req, res, next) => {
  try {
    const admin = req.admin;
    
    if (!admin) {
      return next();
    }
    
    // Check if admin is still active
    const currentAdmin = await Admin.findById(admin._id);
    
    if (!currentAdmin || !currentAdmin.isActive) {
      console.warn('⚠️ Inactive admin session detected:', admin._id);
      
      return res.status(401).json({
        success: false,
        message: 'Admin account has been deactivated.',
        code: 'ACCOUNT_DEACTIVATED'
      });
    }
    
    // Check for suspicious IP change (optional)
    // if (currentAdmin.lastIP && currentAdmin.lastIP !== admin.ip) {
    //   console.warn('⚠️ Admin IP changed:', {
    //     adminId: admin._id,
    //     oldIP: currentAdmin.lastIP,
    //     newIP: admin.ip
    //   });
    //   // You can add additional verification here
    // }
    
    next();
  } catch (error) {
    console.error('Session validation error:', error);
    next();
  }
};

// Detect and block suspicious patterns
exports.detectSuspiciousActivity = (req, res, next) => {
  const url = req.url.toLowerCase();
  const body = JSON.stringify(req.body).toLowerCase();
  
  // Suspicious patterns
  const suspiciousPatterns = [
    'script',
    'javascript:',
    'onerror',
    'onload',
    '<script',
    'document.cookie',
    '../',
    '..\\',
    'DROP TABLE',
    'SELECT * FROM',
    'UNION SELECT',
    'INSERT INTO',
    '--',
    ';--',
    '/*',
    '*/',
    'xp_cmdshell',
    'eval(',
    'base64_decode'
  ];
  
  for (const pattern of suspiciousPatterns) {
    if (url.includes(pattern) || body.includes(pattern)) {
      console.error('🚨 SECURITY ALERT: Suspicious pattern detected!', {
        pattern,
        ip: req.ip,
        url: req.url,
        method: req.method,
        timestamp: new Date().toISOString()
      });
      
      return res.status(403).json({
        success: false,
        message: 'Suspicious activity detected. Request blocked.'
      });
    }
  }
  
  next();
};
