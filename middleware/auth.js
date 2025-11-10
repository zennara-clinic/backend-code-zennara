const jwt = require('jsonwebtoken');
const Token = require('../models/Token');
const User = require('../models/User');
const Admin = require('../models/Admin');

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

// Protect admin routes - verify admin JWT token with enhanced security
exports.protectAdmin = async (req, res, next) => {
  try {
    let token;
    const clientIP = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('user-agent');

    // Log admin access attempt
    console.log('🔐 Admin access attempt:', {
      ip: clientIP,
      url: req.url,
      method: req.method,
      timestamp: new Date().toISOString()
    });

    // Check if token exists in Authorization header
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      console.warn('⚠️ Unauthorized admin access attempt from:', clientIP);
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

      // Check for suspicious activity (optional: implement rate tracking per admin)
      const Admin = require('../models/Admin');
      
      // Update last login
      admin.lastLogin = Date.now();
      await admin.save();

      // Add admin info to request with IP tracking
      req.admin = {
        _id: admin._id,
        email: admin.email,
        role: admin.role,
        ip: clientIP,
        userAgent: userAgent
      };
      
      // Log successful admin authentication
      console.log('✅ Admin authenticated:', {
        adminId: admin._id,
        email: admin.email,
        role: admin.role,
        ip: clientIP
      });
      
      // Log admin activity
      console.log('📝 Admin Activity:', {
        adminId: admin._id,
        adminEmail: admin.email,
        action: `${req.method} ${req.path}`,
        ip: clientIP,
        timestamp: new Date().toISOString()
      });
      
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
