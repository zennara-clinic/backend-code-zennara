const jwt = require('jsonwebtoken');
const Token = require('../models/Token');
const User = require('../models/User');

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

      // Check if user account still exists and is active
      const user = await User.findById(decoded.userId).select('isActive');
      
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
      
      // Add user info to request
      req.user = decoded;
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
