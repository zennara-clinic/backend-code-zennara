const jwt = require('jsonwebtoken');
const Token = require('../models/Token');
const User = require('../models/User');
const Admin = require('../models/Admin');
const AdminAuditLog = require('../models/AdminAuditLog');

// Protect routes - verify JWT token
exports.protect = async (req, res, next) => {
  try {
    let token;

    // Check if token exists in Authorization header
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Not authorized. Please login to access this resource.'
      });
    }

    try {
      // Verify JWT token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      
      // Check if token exists and is valid in database
      const tokenDoc = await Token.findOne({ token, isActive: true });
      
      if (!tokenDoc) {
        return res.status(401).json({
          success: false,
          message: 'Session expired. Please login again.',
          code: 'SESSION_EXPIRED'
        });
      }

      // Check if token has expired
      if (!tokenDoc.isValid()) {
        await tokenDoc.revoke();
        return res.status(401).json({
          success: false,
          message: 'Session expired. Please login again.',
          code: 'SESSION_EXPIRED'
        });
      }

      // Check if user account still exists and is active (fetch full user data)
      const user = await User.findById(decoded.userId).select('-password -otp -otpExpires');
      
      if (!user) {
        // User account deleted - revoke all tokens
        await Token.revokeAllUserTokens(decoded.userId);
        return res.status(401).json({
          success: false,
          message: 'Account not found. Please contact support.',
          code: 'ACCOUNT_DELETED'
        });
      }

      if (!user.isActive) {
        // Account deactivated - revoke all tokens
        await Token.revokeAllUserTokens(decoded.userId);
        return res.status(401).json({
          success: false,
          message: 'Your account has been deactivated. Please contact support.',
          code: 'ACCOUNT_DEACTIVATED'
        });
      }

      // Update last used time
      tokenDoc.lastUsedAt = Date.now();
      await tokenDoc.save();
      
      // Convert Mongoose document to plain object and add to request
      req.user = {
        _id: user._id,
        email: user.email,
        fullName: user.fullName,
        phone: user.phone,
        location: user.location,
        dateOfBirth: user.dateOfBirth,
        gender: user.gender,
        memberType: user.memberType || 'Regular Member',
        zenMembershipStartDate: user.zenMembershipStartDate,
        zenMembershipExpiryDate: user.zenMembershipExpiryDate,
        zenMembershipAutoRenew: user.zenMembershipAutoRenew,
        profilePicture: user.profilePicture,
        isVerified: user.isVerified,
        isActive: user.isActive,
        createdAt: user.createdAt
      };
      req.tokenId = tokenDoc._id;
      
      next();
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          message: 'Session expired. Please login again.',
          code: 'SESSION_EXPIRED'
        });
      }
      
      return res.status(401).json({
        success: false,
        message: 'Invalid token. Please login again.'
      });
    }
  } catch (error) {
    console.error('❌ Authentication error');
    res.status(500).json({
      success: false,
      message: 'Authentication failed'
    });
  }
};

// Protect admin routes - verify admin JWT token
exports.protectAdmin = async (req, res, next) => {
  try {
    let token;

    // Check if token exists in Authorization header
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Not authorized. Admin access required.'
      });
    }

    try {
      // Verify JWT token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      
      // Check if this is an admin token
      if (decoded.role !== 'admin') {
        return res.status(403).json({
          success: false,
          message: 'Access denied. Admin privileges required.'
        });
      }

      // Check if admin account still exists and is active
      const admin = await Admin.findById(decoded.adminId);
      
      if (!admin) {
        return res.status(401).json({
          success: false,
          message: 'Admin account not found.',
          code: 'ACCOUNT_DELETED'
        });
      }

      if (!admin.isActive) {
        return res.status(401).json({
          success: false,
          message: 'Your admin account has been deactivated.',
          code: 'ACCOUNT_DEACTIVATED'
        });
      }

      // Update last login
      admin.lastLogin = Date.now();
      await admin.save();

      // Add admin info to request
      req.admin = {
        _id: admin._id,
        email: admin.email,
        name: admin.name,
        role: admin.role,
        isActive: admin.isActive
      };
      
      // Extract IP and user agent for audit logging
      req.adminIp = req.ip || req.connection.remoteAddress;
      req.adminUserAgent = req.get('user-agent');
      
      next();
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          message: 'Session expired. Please login again.',
          code: 'SESSION_EXPIRED'
        });
      }
      
      return res.status(401).json({
        success: false,
        message: 'Invalid token. Please login again.'
      });
    }
  } catch (error) {
    console.error('❌ Admin authentication error:', error);
    res.status(500).json({
      success: false,
      message: 'Authentication failed'
    });
  }
};

// Role-based access control middleware
exports.requireRole = (...allowedRoles) => {
  return async (req, res, next) => {
    try {
      if (!req.admin) {
        return res.status(401).json({
          success: false,
          message: 'Admin authentication required'
        });
      }

      if (!allowedRoles.includes(req.admin.role)) {
        // Log unauthorized access attempt
        await AdminAuditLog.logAction({
          adminId: req.admin._id,
          adminEmail: req.admin.email,
          action: 'PERMISSION_DENIED',
          resource: 'SECURITY',
          details: {
            attemptedRole: req.admin.role,
            requiredRoles: allowedRoles,
            endpoint: req.originalUrl,
            method: req.method
          },
          ipAddress: req.adminIp || req.ip,
          userAgent: req.adminUserAgent,
          status: 'FAILED',
          errorMessage: `Role '${req.admin.role}' not authorized for this operation`
        });

        return res.status(403).json({
          success: false,
          message: 'Insufficient permissions. This action requires elevated privileges.',
          requiredRole: allowedRoles
        });
      }

      next();
    } catch (error) {
      console.error('❌ Role verification error:', error);
      res.status(500).json({
        success: false,
        message: 'Permission verification failed'
      });
    }
  };
};

// Audit logging middleware - logs all admin actions
exports.auditLog = (action, resource) => {
  return async (req, res, next) => {
    // Store original res.json to intercept response
    const originalJson = res.json.bind(res);
    
    res.json = function(data) {
      // Log action after response
      setImmediate(async () => {
        try {
          if (req.admin) {
            const status = res.statusCode >= 200 && res.statusCode < 300 ? 'SUCCESS' : 'FAILED';
            
            await AdminAuditLog.logAction({
              adminId: req.admin._id,
              adminEmail: req.admin.email,
              action,
              resource,
              resourceId: req.params.id || req.body.id || null,
              details: {
                endpoint: req.originalUrl,
                method: req.method,
                body: sanitizeLogData(req.body),
                query: req.query
              },
              ipAddress: req.adminIp || req.ip,
              userAgent: req.adminUserAgent,
              status,
              errorMessage: status === 'FAILED' ? data.message : null
            });
          }
        } catch (error) {
          console.error('❌ Audit logging error:', error);
        }
      });
      
      return originalJson(data);
    };
    
    next();
  };
};

// Protect routes - allow both user and admin
exports.protectBoth = async (req, res, next) => {
  try {
    let token;

    // Check if token exists in Authorization header
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Not authorized. Please login to access this resource.'
      });
    }

    try {
      // Verify JWT token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      
      // Check if it's an admin token
      if (decoded.role === 'admin' && decoded.adminId) {
        const admin = await Admin.findById(decoded.adminId);
        
        if (!admin) {
          return res.status(401).json({
            success: false,
            message: 'Admin account not found.',
            code: 'ACCOUNT_DELETED'
          });
        }

        if (!admin.isActive) {
          return res.status(401).json({
            success: false,
            message: 'Your admin account has been deactivated.',
            code: 'ACCOUNT_DEACTIVATED'
          });
        }

        // Update last login
        admin.lastLogin = Date.now();
        await admin.save();

        // Add admin info to request
        req.admin = {
          _id: admin._id,
          email: admin.email,
          name: admin.name,
          role: admin.role,
          isActive: admin.isActive
        };
        
        // Extract IP and user agent for audit logging
        req.adminIp = req.ip || req.connection.remoteAddress;
        req.adminUserAgent = req.get('user-agent');
        
        return next();
      }
      
      // Otherwise, treat as user token
      if (decoded.userId) {
        // Check if token exists and is valid in database
        const tokenDoc = await Token.findOne({ token, isActive: true });
        
        if (!tokenDoc) {
          return res.status(401).json({
            success: false,
            message: 'Session expired. Please login again.',
            code: 'SESSION_EXPIRED'
          });
        }

        // Check if token has expired
        if (!tokenDoc.isValid()) {
          await tokenDoc.revoke();
          return res.status(401).json({
            success: false,
            message: 'Session expired. Please login again.',
            code: 'SESSION_EXPIRED'
          });
        }

        // Check if user account still exists and is active
        const user = await User.findById(decoded.userId).select('-password -otp -otpExpires');
        
        if (!user) {
          await Token.revokeAllUserTokens(decoded.userId);
          return res.status(401).json({
            success: false,
            message: 'Account not found. Please contact support.',
            code: 'ACCOUNT_DELETED'
          });
        }

        if (!user.isActive) {
          await Token.revokeAllUserTokens(decoded.userId);
          return res.status(401).json({
            success: false,
            message: 'Your account has been deactivated. Please contact support.',
            code: 'ACCOUNT_DEACTIVATED'
          });
        }

        // Update last used time
        tokenDoc.lastUsedAt = Date.now();
        await tokenDoc.save();
        
        // Add user to request
        req.user = {
          _id: user._id,
          email: user.email,
          fullName: user.fullName,
          phone: user.phone,
          location: user.location,
          dateOfBirth: user.dateOfBirth,
          gender: user.gender,
          memberType: user.memberType || 'Regular Member',
          zenMembershipStartDate: user.zenMembershipStartDate,
          zenMembershipExpiryDate: user.zenMembershipExpiryDate,
          zenMembershipAutoRenew: user.zenMembershipAutoRenew,
          profilePicture: user.profilePicture,
          isVerified: user.isVerified,
          isActive: user.isActive,
          createdAt: user.createdAt
        };
        req.tokenId = tokenDoc._id;
        
        return next();
      }
      
      // If neither user nor admin token
      return res.status(401).json({
        success: false,
        message: 'Invalid token format.'
      });
      
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          message: 'Session expired. Please login again.',
          code: 'SESSION_EXPIRED'
        });
      }
      
      return res.status(401).json({
        success: false,
        message: 'Invalid token. Please login again.'
      });
    }
  } catch (error) {
    console.error('❌ Authentication error');
    res.status(500).json({
      success: false,
      message: 'Authentication failed'
    });
  }
};

// Optional auth - allows both authenticated and guest access
// If token is present and valid, populate req.user; otherwise continue as guest
exports.optionalAuth = async (req, res, next) => {
  try {
    let token;

    // Check if token exists in Authorization header
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    // If no token, continue as guest
    if (!token) {
      req.user = null;
      req.isGuest = true;
      return next();
    }

    try {
      // Verify JWT token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      
      // Check if token exists and is valid in database
      const tokenDoc = await Token.findOne({ token, isActive: true });
      
      if (!tokenDoc || !tokenDoc.isValid()) {
        // Invalid token - continue as guest
        req.user = null;
        req.isGuest = true;
        return next();
      }

      // Check if user account still exists and is active
      const user = await User.findById(decoded.userId).select('-password -otp -otpExpires');
      
      if (!user || !user.isActive) {
        // User not found or inactive - continue as guest
        req.user = null;
        req.isGuest = true;
        return next();
      }

      // Update last used time
      tokenDoc.lastUsedAt = Date.now();
      await tokenDoc.save();
      
      // Add authenticated user to request
      req.user = {
        _id: user._id,
        email: user.email,
        fullName: user.fullName,
        phone: user.phone,
        location: user.location,
        dateOfBirth: user.dateOfBirth,
        gender: user.gender,
        memberType: user.memberType || 'Regular Member',
        zenMembershipStartDate: user.zenMembershipStartDate,
        zenMembershipExpiryDate: user.zenMembershipExpiryDate,
        zenMembershipAutoRenew: user.zenMembershipAutoRenew,
        profilePicture: user.profilePicture,
        isVerified: user.isVerified,
        isActive: user.isActive,
        createdAt: user.createdAt
      };
      req.tokenId = tokenDoc._id;
      req.isGuest = false;
      
      next();
    } catch (error) {
      // Token verification failed - continue as guest
      req.user = null;
      req.isGuest = true;
      next();
    }
  } catch (error) {
    console.error('❌ Optional authentication error');
    // On error, continue as guest
    req.user = null;
    req.isGuest = true;
    next();
  }
};

// Helper to sanitize sensitive data from logs
function sanitizeLogData(data) {
  if (!data || typeof data !== 'object') return data;
  
  const sanitized = { ...data };
  const sensitiveFields = ['password', 'otp', 'token', 'secret', 'apiKey'];
  
  sensitiveFields.forEach(field => {
    if (sanitized[field]) {
      sanitized[field] = '[REDACTED]';
    }
  });
  
  return sanitized;
}
