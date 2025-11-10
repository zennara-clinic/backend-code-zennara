const Admin = require('../models/Admin');
const Token = require('../models/Token');
const AdminAuditLog = require('../models/AdminAuditLog');
const jwt = require('jsonwebtoken');
const { sendAdminOTP } = require('../utils/emailService');

// Optional SecurityLog - won't break auth if it fails
let SecurityLog;
try {
  SecurityLog = require('../models/SecurityLog');
} catch (err) {
  console.log('⚠️ SecurityLog not available, logging disabled');
  SecurityLog = null;
}

// @desc    Admin Login (send OTP)
// @route   POST /api/admin/auth/login
// @access  Public
exports.adminLogin = async (req, res) => {
  try {
    const { email } = req.body;

    // Validate email
    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Please provide email address'
      });
    }

    // Check if email is authorized
    if (!Admin.isAuthorizedEmail(email)) {
      // Log unauthorized access attempt
      try {
        const tempAdmin = await Admin.findOne({ email: email.toLowerCase() });
        if (tempAdmin) {
          await AdminAuditLog.logAction({
            adminId: tempAdmin._id,
            adminEmail: email,
            action: 'UNAUTHORIZED_ACCESS_ATTEMPT',
            resource: 'AUTH',
            details: { reason: 'Email not in authorized list' },
            ipAddress: req.ip || req.connection.remoteAddress,
            userAgent: req.get('user-agent'),
            status: 'FAILED',
            errorMessage: 'Unauthorized email address'
          });
        }
      } catch (logError) {
        console.log('⚠️ Failed to log unauthorized attempt:', logError.message);
      }
      
      return res.status(403).json({
        success: false,
        message: 'Unauthorized email. Only authorized administrators can access the admin panel.'
      });
    }

    // Find or create admin
    const admin = await Admin.findOrCreateAdmin(email);

    // Check if account is locked
    const rateLimitCheck = admin.canRequestOTP();
    if (!rateLimitCheck.allowed) {
      return res.status(429).json({
        success: false,
        message: rateLimitCheck.reason
      });
    }

    // Generate OTP (6-digit for admin)
    const otp = admin.generateOTP();
    await admin.save({ validateModifiedOnly: true });

    // Log OTP request (non-blocking)
    if (SecurityLog) {
      try {
        await SecurityLog.logEvent(admin._id, 'admin_otp_requested', {
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
          deviceInfo: {
            platform: req.headers['user-agent'] || 'unknown',
            deviceId: req.headers['device-id'],
            appVersion: req.headers['app-version']
          }
        });
      } catch (logError) {
        console.log('⚠️ Security log failed (non-critical):', logError.message);
      }
    }

    // Send OTP via email
    try {
      await sendAdminOTP(admin.email, admin.name, otp);
      
      // Log OTP request
      await AdminAuditLog.logAction({
        adminId: admin._id,
        adminEmail: admin.email,
        action: 'OTP_REQUESTED',
        resource: 'AUTH',
        details: { method: 'email' },
        ipAddress: req.ip || req.connection.remoteAddress,
        userAgent: req.get('user-agent'),
        status: 'SUCCESS'
      });
      
      res.status(200).json({
        success: true,
        message: 'OTP sent successfully to your email',
        data: {
          email: admin.email,
          expiresIn: '10 minutes'
        }
      });
    } catch (emailError) {
      console.error('Admin email sending error:', emailError);
      // Clear OTP if email fails
      admin.clearOTP();
      await admin.save({ validateModifiedOnly: true });
      
      res.status(500).json({
        success: false,
        message: 'Failed to send OTP. Please try again.'
      });
    }
  } catch (error) {
    console.error('❌ Admin login failed:', error);
    res.status(500).json({
      success: false,
      message: 'Login failed. Please try again.'
    });
  }
};

// @desc    Verify Admin OTP and login
// @route   POST /api/admin/auth/verify-otp
// @access  Public
exports.adminVerifyOTP = async (req, res) => {
  try {
    const { email, otp } = req.body;

    // Validate input
    if (!email || !otp) {
      return res.status(400).json({
        success: false,
        message: 'Please provide email and OTP'
      });
    }

    // Find admin
    const admin = await Admin.findOne({ email: email.toLowerCase() });

    if (!admin) {
      return res.status(404).json({
        success: false,
        message: 'Admin not found'
      });
    }

    // Verify OTP
    const verificationResult = admin.verifyOTP(otp);

    if (!verificationResult.success) {
      await admin.save({ validateModifiedOnly: true }); // Save attempt counts
      
      // Log failed verification
      await AdminAuditLog.logAction({
        adminId: admin._id,
        adminEmail: admin.email,
        action: 'FAILED_LOGIN',
        resource: 'AUTH',
        details: { 
          reason: verificationResult.message,
          attempts: admin.otpAttempts,
          failedLoginAttempts: admin.failedLoginAttempts
        },
        ipAddress: req.ip || req.connection.remoteAddress,
        userAgent: req.get('user-agent'),
        status: 'FAILED',
        errorMessage: verificationResult.message
      });
      
      // Log failed verification (non-blocking - legacy)
      if (SecurityLog) {
        try {
          await SecurityLog.logEvent(admin._id, 'admin_otp_failed', {
            ipAddress: req.ip,
            userAgent: req.headers['user-agent'],
            success: false,
            errorMessage: verificationResult.message,
            severity: admin.otpAttempts >= 3 ? 'high' : 'medium'
          });
        } catch (logError) {
          console.log('⚠️ Security log failed (non-critical):', logError.message);
        }
      }
      
      return res.status(400).json({
        success: false,
        message: verificationResult.message
      });
    }

    // Update admin
    admin.isVerified = true;
    admin.lastLogin = Date.now();
    admin.clearOTP();
    await admin.save({ validateModifiedOnly: true });

    // Log successful verification (non-blocking)
    if (SecurityLog) {
      try {
        await SecurityLog.logEvent(admin._id, 'admin_otp_verified', {
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
          severity: 'low'
        });
      } catch (logError) {
        console.log('⚠️ Security log failed (non-critical):', logError.message);
      }
    }

    // Create device info for token
    const deviceInfo = {
      platform: req.headers['user-agent'] || 'unknown',
      deviceId: req.headers['device-id'] || null,
      deviceName: req.headers['device-name'] || null,
      appVersion: req.headers['app-version'] || null
    };

    // Generate JWT token (24 hours for admin)
    const token = jwt.sign(
      { 
        adminId: admin._id, 
        email: admin.email,
        role: admin.role,
        type: 'admin'
      },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 1); // 24 hours

    // Save token to database
    const tokenDoc = new Token({
      userId: admin._id,
      userType: 'Admin',
      token,
      type: 'admin_access',
      deviceInfo,
      ipAddress: req.ip || req.connection.remoteAddress,
      expiresAt,
      isActive: true
    });

    await tokenDoc.save();

    // Log successful login
    await AdminAuditLog.logAction({
      adminId: admin._id,
      adminEmail: admin.email,
      action: 'LOGIN',
      resource: 'AUTH',
      details: { 
        role: admin.role,
        deviceInfo
      },
      ipAddress: req.ip || req.connection.remoteAddress,
      userAgent: req.get('user-agent'),
      status: 'SUCCESS'
    });

    // Log successful login (non-blocking - legacy)
    if (SecurityLog) {
      try {
        await SecurityLog.logEvent(admin._id, 'admin_login_success', {
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
          deviceInfo,
          severity: 'low'
        });
      } catch (logError) {
        console.log('⚠️ Security log failed (non-critical):', logError.message);
      }
    }

    console.log('✅ Admin logged in successfully:', admin.email);

    res.status(200).json({
      success: true,
      message: 'Login successful',
      data: {
        token,
        expiresAt,
        admin: {
          id: admin._id,
          email: admin.email,
          name: admin.name,
          role: admin.role,
          isVerified: admin.isVerified
        }
      }
    });
  } catch (error) {
    console.error('❌ Admin OTP verification failed:', error);
    console.error('❌ Error details:', error.message);
    console.error('❌ Stack trace:', error.stack);
    res.status(500).json({
      success: false,
      message: 'Verification failed. Please try again.',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// @desc    Resend Admin OTP
// @route   POST /api/admin/auth/resend-otp
// @access  Public
exports.adminResendOTP = async (req, res) => {
  try {
    const { email } = req.body;

    // Validate email
    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Please provide email address'
      });
    }

    // Check if email is authorized
    if (!Admin.isAuthorizedEmail(email)) {
      return res.status(403).json({
        success: false,
        message: 'Unauthorized email'
      });
    }

    // Find admin
    const admin = await Admin.findOne({ email: email.toLowerCase() });

    if (!admin) {
      return res.status(404).json({
        success: false,
        message: 'Admin not found'
      });
    }

    // Check rate limiting
    const rateLimitCheck = admin.canRequestOTP();
    if (!rateLimitCheck.allowed) {
      return res.status(429).json({
        success: false,
        message: rateLimitCheck.reason
      });
    }

    // Generate new OTP
    const otp = admin.generateOTP();
    await admin.save({ validateModifiedOnly: true });

    // Send OTP via email
    try {
      await sendAdminOTP(admin.email, admin.name, otp);
      
      res.status(200).json({
        success: true,
        message: 'OTP resent successfully',
        data: {
          email: admin.email,
          expiresIn: '10 minutes'
        }
      });
    } catch (emailError) {
      console.error('Admin email sending error:', emailError);
      
      res.status(500).json({
        success: false,
        message: 'Failed to resend OTP. Please try again.'
      });
    }
  } catch (error) {
    console.error('❌ Resend admin OTP failed:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to resend OTP. Please try again.'
    });
  }
};

// @desc    Admin Logout (revoke token)
// @route   POST /api/admin/auth/logout
// @access  Private (Admin)
exports.adminLogout = async (req, res) => {
  try {
    // Get token from request
    const token = req.headers.authorization?.split(' ')[1];

    if (token) {
      // Find and revoke the token
      const tokenDoc = await Token.findOne({ token, isActive: true });
      
      if (tokenDoc) {
        await tokenDoc.revoke();
        console.log('✅ Admin token revoked successfully');
      }
    }

    res.status(200).json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (error) {
    console.error('❌ Admin logout failed:', error);
    res.status(500).json({
      success: false,
      message: 'Logout failed. Please try again.'
    });
  }
};

// @desc    Get current admin profile
// @route   GET /api/admin/auth/me
// @access  Private (Admin)
exports.getAdminProfile = async (req, res) => {
  try {
    const admin = await Admin.findById(req.admin._id)
      .select('-otp -otpExpiry')
      .lean();

    if (!admin) {
      return res.status(404).json({
        success: false,
        message: 'Admin not found'
      });
    }

    res.status(200).json({
      success: true,
      data: {
        id: admin._id,
        email: admin.email,
        name: admin.name,
        role: admin.role,
        isVerified: admin.isVerified,
        createdAt: admin.createdAt
      }
    });
  } catch (error) {
    console.error('❌ Get admin profile failed:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch profile. Please try again.'
    });
  }
};

// @desc    Check if email is authorized
// @route   POST /api/admin/auth/check-email
// @access  Public
exports.checkAuthorizedEmail = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Please provide email address'
      });
    }

    const isAuthorized = Admin.isAuthorizedEmail(email);

    res.status(200).json({
      success: true,
      data: {
        isAuthorized,
        message: isAuthorized 
          ? 'Email is authorized for admin access' 
          : 'Email is not authorized'
      }
    });
  } catch (error) {
    console.error('❌ Check authorized email failed:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check email authorization.'
    });
  }
};
