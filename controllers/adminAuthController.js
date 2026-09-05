const Admin = require('../models/Admin');
const Token = require('../models/Token');
const AdminAuditLog = require('../models/AdminAuditLog');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const { sendAdminOTP } = require('../utils/emailService');
const { computeEffectivePermissions } = require('../middleware/auth');

/**
 * Which roles sign in with a password.
 *
 * The clinic's rule: the admin panel is email + emailed code only (super admins
 * and `staff`), the dermatologist and floor panels are email + password. Both
 * login endpoints enforce this from the same list so they cannot drift.
 */
/** Empty since 2026-09-05: every panel signs in with an emailed one-time code. */
const PASSWORD_ROLES = [];
exports.PASSWORD_ROLES = PASSWORD_ROLES;

/**
 * Shared shape for the logged-in admin, with RBAC fields the panel gates on.
 * `permissions` is the flattened effective set (empty for super_admin, who is
 * flagged with `isSuperAdmin` and treated as holding everything client-side).
 */
async function buildAdminPayload(admin) {
  const eff = await computeEffectivePermissions(admin);
  return {
    _id: admin._id,
    id: admin._id,
    email: admin.email,
    name: admin.name,
    role: admin.role,
    phone: admin.phone || null,
    photo: admin.photo || null,
    branchId: admin.branchId || null,
    branchIds: (admin.branchIds && admin.branchIds.length) ? admin.branchIds : (admin.branchId ? [admin.branchId] : []),
    doctorId: admin.doctorId || null,
    isActive: admin.isActive,
    isVerified: admin.isVerified,
    // RBAC
    isSuperAdmin: eff.isSuperAdmin,
    customRoleId: admin.customRoleId || null,
    roleKey: eff.roleKey,
    roleName: eff.roleName,
    permissions: Array.from(eff.permissions),
    toursSeen: Array.isArray(admin.toursSeen) ? admin.toursSeen : [],
  };
}
exports.buildAdminPayload = buildAdminPayload;

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

    // Check if email is authorized — env list or an active staff account.
    const staffLogin = await Admin.resolveLogin(email);
    if (!staffLogin) {
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

    const admin = staffLogin;

    // Dermatologists and therapists sign in with a password only — no codes.

    // Check if account is locked

    // A code may be re-sent at most every 30 seconds per account, whatever the
    // client says — this is what stops an inbox being flooded by a script.
    if (admin.lastOtpRequest && Date.now() - new Date(admin.lastOtpRequest).getTime() < 30 * 1000) {
      const wait = Math.ceil((30 * 1000 - (Date.now() - new Date(admin.lastOtpRequest).getTime())) / 1000);
      return res.status(429).json({ success: false, message: `Please wait ${wait}s before requesting another code.` });
    }
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

    // Dermatologists and therapists sign in with a password only — no codes.

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

    // Session token: 24h absolute life (protectAdmin also enforces an idle
    // limit), stamped with the account's sessionVersion so "sign out
    // everywhere" and deactivation end every session at once.
    const token = jwt.sign(
      { 
        adminId: admin._id, 
        email: admin.email,
        role: admin.role,
        type: 'admin',
        sv: admin.sessionVersion || 1,
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
      // Only the hash is stored: a database read can never yield a live session.
      tokenHash: hashToken(token),
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
        admin: await buildAdminPayload(admin),
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

    // Check if email is authorized (env list or active staff account)
    if (!(await Admin.resolveLogin(email))) {
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

    // Dermatologists and therapists sign in with a password only — no codes.

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
      const tokenDoc = await Token.findOne({ $or: [{ tokenHash: hashToken(token) }, { token }], isActive: true });
      
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

    // `_id` as well as `id`: clients that store this record alongside
    // documents from other endpoints compare on `_id`, and returning only
    // `id` left those comparisons undefined.
    const payload = await buildAdminPayload(admin);
    res.status(200).json({
      success: true,
      data: {
        ...payload,
        lastLogin: admin.lastLogin,
        createdAt: admin.createdAt,
        loginMethod: 'otp',
      },
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

    const isAuthorized = !!(await Admin.resolveLogin(email));

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


/** Issue a panel session for an authenticated admin (shared by OTP and password logins). */
async function issueAdminSession(req, admin) {
    const deviceInfo = {
      userAgent: req.headers['user-agent'],
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

    return { token, expiresAt };
}

// @desc    Password login for the clinical panels (dermatologists, therapists)
// @route   POST /api/admin/auth/login-password
//
// Passwords belong to the dermatologist and floor panels only. Admin-panel
// accounts — super admins and granular `staff` — sign in with an emailed
// one-time code and have no password at all, so this refuses them by role
// rather than leaving two ways into the same panel.

// @desc    Change my login email / phone
// @route   PUT /api/admin/auth/me/contact
exports.updateMyContact = async (req, res) => {
  try {
    const { email, phone } = req.body || {};
    const admin = await Admin.findById(req.admin._id);
    if (!admin) return res.status(404).json({ success: false, message: 'Account not found' });

    const nextEmail = email !== undefined ? String(email).toLowerCase().trim() : undefined;
    const emailChanging = nextEmail !== undefined && nextEmail !== admin.email;

    if (emailChanging) {
      if (!/^\S+@\S+\.\S+$/.test(nextEmail)) {
        return res.status(400).json({ success: false, message: 'Enter a valid email address' });
      }
      // Changing the sign-in address needs the current password when one exists.
      const taken = await Admin.findOne({ email: nextEmail, _id: { $ne: admin._id } });
      if (taken) return res.status(400).json({ success: false, message: 'Another account already uses this email' });
    }

    const previousEmail = admin.email;
    if (emailChanging) admin.email = nextEmail;
    if (phone !== undefined) admin.phone = String(phone).trim() || null;
    await admin.save({ validateModifiedOnly: true });

    // Keep the Doctor profile in sync — ensureDoctorLogin copies the profile's
    // email/phone onto this account, so a one-sided change would be reverted.
    if (admin.role === 'doctor') {
      try {
        const Doctor = require('../models/Doctor');
        const doctor = admin.doctorId
          ? await Doctor.findById(admin.doctorId)
          : await Doctor.findOne({ email: previousEmail });
        if (doctor) {
          if (emailChanging) doctor.email = admin.email;
          if (phone !== undefined) doctor.phone = admin.phone;
          await doctor.save({ validateModifiedOnly: true });
        }
      } catch (syncError) {
        console.error('⚠️ Doctor profile sync failed (account already updated):', syncError.message);
      }
    }

    await AdminAuditLog.logAction({
      adminId: admin._id,
      adminEmail: admin.email,
      action: 'STAFF_UPDATED',
      resource: 'ADMIN',
      resourceId: String(admin._id),
      details: {
        self: true,
        ...(emailChanging ? { emailFrom: previousEmail, emailTo: admin.email } : {}),
        ...(phone !== undefined ? { phone: admin.phone } : {}),
      },
      ipAddress: req.adminIp || req.ip,
      userAgent: req.adminUserAgent || req.get('user-agent'),
    }).catch(() => undefined);

    return res.status(200).json({
      success: true,
      message: emailChanging ? `Saved — you now sign in as ${admin.email}` : 'Saved',
      data: {
        _id: admin._id,
        id: admin._id,
        email: admin.email,
        name: admin.name,
        role: admin.role,
        phone: admin.phone || null,
        isActive: admin.isActive,
        isVerified: admin.isVerified,
      },
    });
  } catch (error) {
    console.error('❌ Update my contact failed:', error);
    return res.status(500).json({ success: false, message: 'Could not save your details. Please try again.' });
  }
};

exports.markTourSeen = async (req, res) => {
  try {
    const key = String(req.body?.key || '').trim();
    if (!key || key.length > 64) {
      return res.status(400).json({ success: false, message: 'A tour key is required' });
    }
    // $addToSet keeps this idempotent — a tour finished twice in two tabs is
    // still one entry.
    const admin = await Admin.findByIdAndUpdate(
      req.admin._id,
      { $addToSet: { toursSeen: key } },
      { new: true },
    ).select('toursSeen').lean();
    return res.json({ success: true, data: { toursSeen: admin?.toursSeen || [] } });
  } catch (error) {
    console.error('❌ markTourSeen failed:', error);
    return res.status(500).json({ success: false, message: 'Could not save tutorial state' });
  }
};

exports.resetTours = async (req, res) => {
  try {
    const key = String(req.query?.key || '').trim();
    const update = key ? { $pull: { toursSeen: key } } : { $set: { toursSeen: [] } };
    const admin = await Admin.findByIdAndUpdate(req.admin._id, update, { new: true })
      .select('toursSeen').lean();
    return res.json({ success: true, data: { toursSeen: admin?.toursSeen || [] } });
  } catch (error) {
    console.error('❌ resetTours failed:', error);
    return res.status(500).json({ success: false, message: 'Could not reset the tutorial' });
  }
};

/**
 * POST /api/admin/auth/me/logout-all — end every session for this account.
 *
 * Bumps sessionVersion (tokens issued before it are refused by protectAdmin)
 * and revokes the stored sessions, so a lost laptop or a shared login is
 * closed from anywhere in one action.
 */
exports.logoutAll = async (req, res) => {
  try {
    await Admin.updateOne({ _id: req.admin._id }, { $inc: { sessionVersion: 1 } });
    await Token.updateMany({ userId: req.admin._id, userType: 'Admin', isActive: true }, { $set: { isActive: false } });
    await AdminAuditLog.logAction({
      adminId: req.admin._id, adminEmail: req.admin.email, action: 'LOGOUT', resource: 'AUTH',
      details: { everywhere: true }, ipAddress: req.adminIp || req.ip, userAgent: req.adminUserAgent, status: 'SUCCESS',
    }).catch(() => {});
    return res.json({ success: true, message: 'Signed out on every device' });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Could not sign out everywhere' });
  }
};

/**
 * Self-service profile: name, phone and photo for the signed-in account. The
 * email is the sign-in address and moves through updateMyContact. A doctor's
 * app card mirrors the same identity, so a dermatologist's own change lands
 * on the Doctor row too (ensureDoctorLogin would otherwise copy it back).
 */
exports.updateMyProfile = async (req, res) => {
  try {
    const { name, phone, photo } = req.body || {};
    const admin = await Admin.findById(req.admin._id);
    if (!admin) return res.status(404).json({ success: false, message: 'Account not found' });

    if (name !== undefined) {
      const next = String(name).trim();
      if (next.length < 2) return res.status(400).json({ success: false, message: 'Enter your name' });
      admin.name = next;
    }
    if (phone !== undefined) admin.phone = String(phone || '').trim() || null;
    if (photo !== undefined) {
      const next = photo ? String(photo).trim() : null;
      if (next && !/^https?:\/\//i.test(next)) return res.status(400).json({ success: false, message: 'The photo must be an uploaded image' });
      admin.photo = next;
    }
    await admin.save({ validateModifiedOnly: true });

    if (admin.role === 'doctor' && admin.doctorId) {
      try {
        const Doctor = require('../models/Doctor');
        const doctor = await Doctor.findById(admin.doctorId);
        if (doctor) {
          if (name !== undefined) doctor.name = admin.name;
          if (phone !== undefined) doctor.phone = admin.phone;
          if (photo !== undefined) doctor.photo = admin.photo;
          await doctor.save({ validateModifiedOnly: true });
        }
      } catch (syncError) {
        console.error('⚠️ Doctor profile sync failed (account already updated):', syncError.message);
      }
    }

    await AdminAuditLog.logAction({
      adminId: admin._id,
      adminEmail: admin.email,
      action: 'STAFF_UPDATED',
      resource: 'ADMIN',
      resourceId: String(admin._id),
      details: { self: true, fields: ['name', 'phone', 'photo'].filter((k) => req.body?.[k] !== undefined) },
      ipAddress: req.adminIp || req.ip,
      userAgent: req.adminUserAgent || req.get('user-agent'),
    }).catch(() => undefined);

    const payload = await buildAdminPayload(admin.toObject());
    return res.status(200).json({ success: true, message: 'Saved', data: payload });
  } catch (error) {
    console.error('❌ Update my profile failed:', error);
    return res.status(500).json({ success: false, message: 'Could not save your profile. Please try again.' });
  }
};
