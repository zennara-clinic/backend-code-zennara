const User = require('../models/User');
const Token = require('../models/Token');
const SignupVerification = require('../models/SignupVerification');
const SecurityLog = require('../models/SecurityLog');
const Booking = require('../models/Booking');
const ProductOrder = require('../models/ProductOrder');
const PackageAssignment = require('../models/PackageAssignment');
const { ageFromDateOfBirth } = require('../utils/dateOfBirth');
const jwt = require('jsonwebtoken');
const { sendOTPEmail, sendWelcomeEmail, sendDataExportEmail } = require('../utils/emailService');
const { uploadToCloudinary, deleteFromCloudinary } = require('../middleware/upload');
const whatsappService = require('../services/whatsappService');
const zenotiSync = require('../services/zenotiSyncService');
const { publicEmail } = require('../config/zenoti');
const logger = require('../utils/logger');
const { filterFields, validateOwnership } = require('../middleware/securityMiddleware');
const accountDeletion = require('../services/accountDeletionService');

const serializeUser = (user) => ({
  id: user._id,
  // A clinic guest with no email in Zenoti carries an internal placeholder;
  // the app must see "no email", never that key.
  email: publicEmail(user.email),
  fullName: user.fullName,
  phone: user.phone,
  location: user.location,
  dateOfBirth: user.dateOfBirth,
  gender: user.gender,
  memberType: user.memberType || 'Regular Member',
  zenMembershipStartDate: user.zenMembershipStartDate || null,
  zenMembershipExpiryDate: user.zenMembershipExpiryDate || null,
  zenMembershipAutoRenew: Boolean(user.zenMembershipAutoRenew),
  medicalHistory: user.medicalHistory || '',
  hasDrugAllergy: user.hasDrugAllergy === true,
  drugAllergies: user.drugAllergies || '',
  dietaryPreferences: user.dietaryPreferences || [],
  smoking: user.smoking || '',
  drinking: user.drinking || '',
  additionalInfo: user.additionalInfo || '',
  profilePicture: user.profilePicture?.url || null,
  isVerified: Boolean(user.isVerified),
  // Zenoti linkage — lets the app know this customer's history lives in the CRM
  // and can be fetched via /api/zenoti/*.
  source: user.source || 'app',
  zenotiLinked: Boolean(user.zenotiGuestId),
  createdAt: user.createdAt,
});

// @desc    Send an OTP before creating a new account
// @route   POST /api/auth/signup/send-otp
// @access  Public
exports.sendSignupOTP = async (req, res) => {
  try {
    const { phone } = req.body;
    const existingUser = await User.exists({ phone });
    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: 'Phone number already registered',
      });
    }

    let verification = await SignupVerification.findOne({ phone });
    if (
      verification?.updatedAt &&
      Date.now() - verification.updatedAt.getTime() < 30 * 1000
    ) {
      return res.status(429).json({
        success: false,
        message: 'Please wait 30 seconds before requesting another OTP.',
      });
    }

    if (!verification) verification = new SignupVerification({ phone });
    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    verification.setOTP(otp);
    await verification.save();

    const whatsappResult = await whatsappService.sendOTP(phone, otp, 5);
    if (!whatsappResult.success) {
      await SignupVerification.deleteOne({ _id: verification._id }).catch(() => {});
      logger.error('Signup OTP WhatsApp delivery failed', {
        phone,
        error: whatsappResult.error,
      });
      return res.status(502).json({
        success: false,
        message: 'Could not send the OTP on WhatsApp. Please try again.',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'OTP sent successfully on WhatsApp',
    });
  } catch (error) {
    logger.error('Signup OTP request failed', { error: error.message });
    return res.status(500).json({
      success: false,
      message: 'Could not send the OTP. Please try again.',
    });
  }
};

// @desc    Verify a new account's phone and issue a short-lived signup proof
// @route   POST /api/auth/signup/verify-otp
// @access  Public
exports.verifySignupOTP = async (req, res) => {
  try {
    const { phone, otp } = req.body;
    const verification = await SignupVerification.findOne({ phone });
    if (!verification) {
      return res.status(400).json({
        success: false,
        message: 'No OTP found. Please request a new one.',
      });
    }

    const result = verification.verifyOTP(otp);
    await verification.save();
    if (!result.success) {
      return res.status(400).json({ success: false, message: result.message });
    }

    const verificationToken = jwt.sign(
      {
        purpose: 'signup',
        phone,
        signupVerificationId: verification._id.toString(),
      },
      process.env.JWT_SECRET,
      { expiresIn: '20m' }
    );

    return res.status(200).json({
      success: true,
      message: 'Phone number verified',
      verificationToken,
    });
  } catch (error) {
    logger.error('Signup OTP verification failed', { error: error.message });
    return res.status(500).json({
      success: false,
      message: 'Could not verify the OTP. Please try again.',
    });
  }
};

// @desc    Register new user
// @route   POST /api/auth/signup
// @access  Public
exports.signup = async (req, res) => {
  let consumedVerificationId = null;
  try {
    const { 
      email, 
      fullName, 
      phone, 
      location, 
      dateOfBirth, 
      gender,
      privacyPolicyAccepted,
      termsAccepted,
      verificationToken,
    } = req.body;

    // Check if all required fields are present
    if (!email || !fullName || !phone || !location || !dateOfBirth || !gender) {
      return res.status(400).json({
        success: false,
        message: 'Please provide all required fields'
      });
    }

    // DPDPA 2023 Compliance: Require explicit consent
    if (!privacyPolicyAccepted || !termsAccepted) {
      return res.status(400).json({
        success: false,
        message: 'You must accept the Privacy Policy and Terms of Service to continue'
      });
    }

    const age = ageFromDateOfBirth(dateOfBirth);
    if (age === null || age > 120) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_DATE_OF_BIRTH',
        message: 'Please enter a valid date of birth.'
      });
    }
    if (age < 18) {
      return res.status(400).json({
        success: false,
        code: 'AGE_RESTRICTION',
        message: 'You must be at least 18 years old to create an account.'
      });
    }

    let verification;
    try {
      const proof = jwt.verify(verificationToken || '', process.env.JWT_SECRET);
      if (proof.purpose !== 'signup' || proof.phone !== phone || !proof.signupVerificationId) {
        throw new Error('Verification proof does not match this phone number');
      }
      verification = await SignupVerification.findOne({
        _id: proof.signupVerificationId,
        phone,
        verifiedAt: { $ne: null },
        usedAt: null,
        expiresAt: { $gt: new Date() },
      });
      if (!verification) throw new Error('Verification proof is no longer valid');
    } catch {
      return res.status(400).json({
        success: false,
        code: 'PHONE_VERIFICATION_REQUIRED',
        message: 'Please verify your phone number before creating an account.',
      });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ 
      $or: [{ email }, { phone }] 
    });

    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: existingUser.email === email 
          ? 'Email already registered' 
          : 'Phone number already registered'
      });
    }

    // Consume the proof atomically. Two simultaneous requests using the same
    // verified phone must never create two accounts.
    const consumedVerification = await SignupVerification.findOneAndUpdate(
      { _id: verification._id, usedAt: null },
      { $set: { usedAt: new Date() } },
      { new: true }
    );
    if (!consumedVerification) {
      return res.status(400).json({
        success: false,
        code: 'PHONE_VERIFICATION_REQUIRED',
        message: 'This phone verification has already been used. Please verify again.',
      });
    }
    consumedVerificationId = consumedVerification._id;

    // Get user's IP address
    const ipAddress = req.ip || req.connection.remoteAddress || req.headers['x-forwarded-for'];

    // Create new user with Regular Member as default
    const user = await User.create({
      email,
      fullName,
      phone,
      location,
      dateOfBirth,
      gender,
      memberType: 'Regular Member', // All new users start as Regular Members
      phoneVerified: true,
      privacyPolicyConsent: {
        accepted: true,
        version: '2026-08-09',
        acceptedAt: new Date(),
        ipAddress: ipAddress
      },
      termsOfServiceConsent: {
        accepted: true,
        version: '2026-08-09',
        acceptedAt: new Date(),
        ipAddress: ipAddress
      },
      dataRetentionConsent: {
        accepted: true,
        retentionPeriodYears: 3,
        acceptedAt: new Date()
      }
    });

    // Send welcome email (non-blocking)
    sendWelcomeEmail(user.email, user.fullName, user.location).catch(err => {
      logger.error('Failed to send welcome email', { error: err.message });
      // Don't fail registration if email fails
    });

    logger.info('User registered successfully', { userId: user._id });

    res.status(201).json({
      success: true,
      message: 'Registration successful! Please login to continue.',
      data: {
        userId: user._id,
        email: user.email,
        fullName: user.fullName
      }
    });
  } catch (error) {
    if (consumedVerificationId) {
      await SignupVerification.updateOne(
        { _id: consumedVerificationId },
        { $set: { usedAt: null } }
      ).catch(() => {});
    }
    console.error('❌ Registration failed:', error);
    console.error('❌ Error name:', error.name);
    console.error('❌ Error message:', error.message);
    
    // Handle Mongoose validation errors
    if (error.name === 'ValidationError') {
      const validationErrors = Object.values(error.errors).map(err => err.message);
      console.error('❌ Validation errors:', validationErrors);
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: validationErrors
      });
    }
    
    // Handle duplicate key errors
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return res.status(400).json({
        success: false,
        message: `${field} already exists`
      });
    }
    
    res.status(500).json({
      success: false,
      message: error.message || 'Registration failed. Please try again.'
    });
  }
};

// @desc    Upgrade user to Zen Member
// @route   POST /api/auth/upgrade-membership
// @access  Private (User must be logged in)
exports.upgradeMembership = async (req, res) => {
  try {
    const userId = req.user._id;

    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Check if already a Zen Member
    if (user.memberType === 'Zen Member') {
      return res.status(400).json({
        success: false,
        message: 'You are already a Zen Member'
      });
    }

    // Upgrade to Zen Member with 30-day expiry
    user.memberType = 'Zen Member';
    user.zenMembershipStartDate = new Date();
    
    // Set expiry to 30 days from now
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + 30);
    user.zenMembershipExpiryDate = expiryDate;
    user.zenMembershipAutoRenew = true;
    
    await user.save();

    logger.info('User upgraded to Zen Member', { userId: user._id, fullName: user.fullName, expiresAt: expiryDate });

    res.status(200).json({
      success: true,
      message: 'Successfully upgraded to Zen Member!',
      data: {
        memberType: user.memberType,
        zenMembershipStartDate: user.zenMembershipStartDate,
        zenMembershipExpiryDate: user.zenMembershipExpiryDate,
        zenMembershipAutoRenew: user.zenMembershipAutoRenew
      }
    });
  } catch (error) {
    console.error('❌ Membership upgrade failed:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to upgrade membership. Please try again.'
    });
  }
};

// @desc    Login user (send OTP)
// @route   POST /api/auth/login
// @access  Public
exports.login = async (req, res) => {
  try {
    const { phone } = req.body;

    // Validate phone
    if (!phone) {
      return res.status(400).json({
        success: false,
        message: 'Please provide phone number'
      });
    }

    // Find user by phone
    let user = await User.findOne({ phone: phone });

    // Not a local account yet — but they may already be a Zenoti (clinic) guest.
    // Existing Zennara customers live in Zenoti, so if this number belongs to a
    // Zenoti guest we mirror them into a local account on the fly and let them
    // sign in without registering again.
    if (!user) {
      user = await zenotiSync.findOrProvisionByPhone(phone);
    }

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'No account found with this phone number. Please sign up first.'
      });
    }

    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        code: 'ACCOUNT_DEACTIVATED',
        message: 'Your account has been deactivated. Please contact support.'
      });
    }

    // Check rate limiting
    const rateLimitCheck = user.canRequestOTP();
    if (!rateLimitCheck.allowed) {
      return res.status(429).json({
        success: false,
        message: rateLimitCheck.reason
      });
    }

    // Generate OTP (now hashed automatically)
    const otp = user.generateOTP();
    await user.save({ validateModifiedOnly: true });

    // Log OTP request
    await SecurityLog.logEvent(user._id, 'otp_requested', {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      deviceInfo: {
        platform: req.headers['user-agent'] || 'unknown',
        deviceId: req.headers['device-id'],
        appVersion: req.headers['app-version']
      }
    });

    // Skip sending OTP for demo account - Apple Review
    if (user.phone === '8945515335') {
      console.log('Demo account detected - OTP: 9876 (fixed for Apple Review)');
      return res.status(200).json({
        success: true,
        message: 'Demo account - Use OTP: 9876',
        data: {
          email: publicEmail(user.email),
          phone: user.phone ? `******${user.phone.slice(-4)}` : null,
          expiresIn: '5 minutes',
          isDemoAccount: true
        }
      });
    }

    // Deliver the OTP. App accounts get it by email and WhatsApp; Zenoti guests
    // with no real email on file get it by WhatsApp only (their placeholder
    // address would just bounce). Login succeeds as long as at least one channel
    // accepts the message.
    const hasRealEmail = Boolean(user.email) && !user.email.endsWith('@guest.zennara.in');
    let emailDelivered = false;
    let whatsappDelivered = false;

    if (hasRealEmail) {
      try {
        await sendOTPEmail(user.email, user.fullName, otp, user.location);
        emailDelivered = true;
        logger.info('OTP email sent', { email: user.email });
      } catch (emailError) {
        console.error('Email sending error:', emailError.message);
      }
    }

    if (user.phone) {
      try {
        const whatsappResult = await whatsappService.sendOTP(user.phone, otp, 5);
        if (whatsappResult.success) {
          whatsappDelivered = true;
          logger.info('OTP WhatsApp sent', { phone: user.phone, messageSid: whatsappResult.messageSid });
        } else {
          logger.warn('WhatsApp OTP failed', { error: whatsappResult.error, code: whatsappResult.code });
        }
      } catch (whatsappError) {
        console.error('WhatsApp OTP exception:', whatsappError.message);
      }
    }

    // Nothing got through — don't leave a live OTP the user can never receive.
    if (!emailDelivered && !whatsappDelivered) {
      user.clearOTP();
      await user.save({ validateModifiedOnly: true });
      return res.status(500).json({
        success: false,
        message: 'Failed to send OTP. Please try again.'
      });
    }

    const channels = [emailDelivered && 'email', whatsappDelivered && 'WhatsApp']
      .filter(Boolean)
      .join(' and ');
    return res.status(200).json({
      success: true,
      message: `OTP sent successfully to your ${channels}`,
      data: {
        email: hasRealEmail ? user.email : null,
        phone: user.phone ? `******${user.phone.slice(-4)}` : null,
        expiresIn: '5 minutes'
      }
    });
  } catch (error) {
    console.error('❌ Login failed');
    res.status(500).json({
      success: false,
      message: 'Login failed. Please try again.'
    });
  }
};

// @desc    Verify OTP and login
// @route   POST /api/auth/verify-otp
// @access  Public
exports.verifyOTP = async (req, res) => {
  try {
    const { phone, otp } = req.body;

    // Validate input
    if (!phone || !otp) {
      return res.status(400).json({
        success: false,
        message: 'Please provide phone number and OTP'
      });
    }

    // Find user
    const user = await User.findOne({ phone: phone });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        code: 'ACCOUNT_DEACTIVATED',
        message: 'Your account has been deactivated. Please contact support.'
      });
    }

    // Verify OTP (now returns detailed result)
    const verificationResult = user.verifyOTP(otp);

    if (!verificationResult.success) {
      await user.save({ validateModifiedOnly: true }); // Save attempt counts
      
      // Log failed verification
      await SecurityLog.logEvent(user._id, 'otp_failed', {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        success: false,
        errorMessage: verificationResult.message,
        severity: user.otpAttempts >= 2 ? 'high' : 'medium'
      });
      
      return res.status(400).json({
        success: false,
        message: verificationResult.message
      });
    }

    // Update user
    user.isVerified = true;
    user.phoneVerified = true;
    user.lastLogin = Date.now();
    user.appOpenCount = (user.appOpenCount || 0) + 1; // Increment app open count
    user.clearOTP();
    await user.save({ validateModifiedOnly: true });

    // Log successful verification
    await SecurityLog.logEvent(user._id, 'otp_verified', {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      severity: 'low'
    });

    // Create device info for token
    const deviceInfo = {
      platform: req.headers['user-agent'] || 'unknown',
      deviceId: req.headers['device-id'] || null,
      deviceName: req.headers['device-name'] || null,
      appVersion: req.headers['app-version'] || null
    };

    // Generate token pair (access + refresh) - for future use
    // For now, keeping 7-day access token for compatibility
    const token = jwt.sign(
      { userId: user._id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE || '7d' }
    );

    // Keep the persisted expiry and the mobile cache aligned with the JWT's
    // actual exp claim, even when JWT_EXPIRE is changed from its 7-day default.
    const decodedToken = jwt.decode(token);
    const expiresAt = new Date(decodedToken.exp * 1000);

    // Save token to database
    const tokenDoc = new Token({
      userId: user._id,
      token,
      type: 'access',
      deviceInfo,
      ipAddress: req.ip || req.connection.remoteAddress,
      expiresAt,
      isActive: true
    });

    await tokenDoc.save();

    // Log successful login
    await SecurityLog.logEvent(user._id, 'login_success', {
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      deviceInfo,
      severity: 'low'
    });

    logger.info('User logged in successfully', { userId: user._id });

    // For Zenoti-linked guests, freshen the local mirror from the CRM in the
    // background so profile changes made at the clinic show up after login.
    // Never block the login response on it.
    if (user.zenotiGuestId) {
      // Profile + Zen membership first (two calls, fast), then the full
      // history mirror when it is stale so appointments, packages and
      // purchases made at the clinic are on screen by the time the app loads.
      zenotiSync.syncLinkedUser(user)
        .catch(() => {})
        .finally(() => require('../services/zenotiImportService').refreshOnLogin(user));
    }

    res.status(200).json({
      success: true,
      message: 'Login successful',
      data: {
        token,
        expiresAt,
        user: serializeUser(user)
      }
    });
  } catch (error) {
    logger.error('OTP verification failed', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Verification failed. Please try again.'
    });
  }
};

// @desc    Resend OTP
// @route   POST /api/auth/resend-otp
// @access  Public
exports.resendOTP = async (req, res) => {
  try {
    const { phone } = req.body;

    // Validate phone
    if (!phone) {
      return res.status(400).json({
        success: false,
        message: 'Please provide phone number'
      });
    }

    // Find user
    const user = await User.findOne({ phone: phone });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        code: 'ACCOUNT_DEACTIVATED',
        message: 'Your account has been deactivated. Please contact support.'
      });
    }

    // Check rate limiting
    const rateLimitCheck = user.canRequestOTP();
    if (!rateLimitCheck.allowed) {
      return res.status(429).json({
        success: false,
        message: rateLimitCheck.reason
      });
    }

    // Generate new OTP (now hashed automatically)
    const otp = user.generateOTP();
    await user.save({ validateModifiedOnly: true });

    // Send OTP via email and WhatsApp
    try {
      // Send OTP via email
      await sendOTPEmail(user.email, user.fullName, otp, user.location);
      logger.info('OTP email resent', { email: user.email });
      
      // Send OTP via WhatsApp (non-blocking)
      if (user.phone) {
        try {
          const whatsappResult = await whatsappService.sendOTP(user.phone, otp, 5);
          
          if (whatsappResult.success) {
            logger.info('OTP WhatsApp resent', { phone: user.phone, messageSid: whatsappResult.messageSid });
          } else {
            logger.warn('WhatsApp OTP resend failed (non-blocking)', { error: whatsappResult.error, code: whatsappResult.code });
            console.error('   Phone number:', user.phone);
          }
        } catch (whatsappError) {
          console.error('WhatsApp OTP exception (non-blocking):', whatsappError.message);
          // Don't fail the request if WhatsApp fails - email OTP is primary
        }
      } else {
        console.log('No phone number available for WhatsApp OTP');
      }
      
      res.status(200).json({
        success: true,
        message: 'OTP resent successfully to your email and WhatsApp',
        data: {
          email: publicEmail(user.email),
          phone: user.phone ? `******${user.phone.slice(-4)}` : null,
          expiresIn: '5 minutes'
        }
      });
    } catch (emailError) {
      console.error('Email sending error:', emailError);
      
      res.status(500).json({
        success: false,
        message: 'Failed to resend OTP. Please try again.'
      });
    }
  } catch (error) {
    console.error('❌ Resend OTP failed');
    res.status(500).json({
      success: false,
      message: 'Failed to resend OTP. Please try again.'
    });
  }
};

// @desc    Logout user (revoke token)
// @route   POST /api/auth/logout
// @access  Private
exports.logout = async (req, res) => {
  try {
    // Get token from request (added by middleware)
    const token = req.headers.authorization?.split(' ')[1];

    if (token) {
      // Find and revoke the token in database
      const tokenDoc = await Token.findOne({ token, isActive: true });
      
      if (tokenDoc) {
        await tokenDoc.revoke();
        logger.info('Token revoked successfully');
      }
    }

    res.status(200).json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (error) {
    console.error('❌ Logout failed');
    res.status(500).json({
      success: false,
      message: 'Logout failed. Please try again.'
    });
  }
};

// @desc    Logout from all devices (revoke all user tokens)
// @route   POST /api/auth/logout-all
// @access  Private
exports.logoutAll = async (req, res) => {
  try {
    // Revoke all active tokens for this user
    await Token.revokeAllUserTokens(req.user._id);
    logger.info('All tokens revoked successfully', { userId: req.user._id });

    res.status(200).json({
      success: true,
      message: 'Logged out from all devices successfully'
    });
  } catch (error) {
    console.error('❌ Logout all devices failed');
    res.status(500).json({
      success: false,
      message: 'Logout failed. Please try again.'
    });
  }
};

// @desc    Get current user profile
// @route   GET /api/auth/me
// @access  Private
exports.getMe = async (req, res) => {
  try {
    logger.debug('Fetching user profile', { userId: req.user._id });
    
    // Use lean() to get plain JavaScript object (no Mongoose caching)
    const user = await User.findById(req.user._id)
      .select('-otp -otpExpiry')
      .lean();

    if (!user) {
      logger.warn('User not found', { userId: req.user._id });
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    logger.debug('Profile fetched from DB', {
      userId: user._id,
      memberType: user.memberType
    });

    res.status(200).json({
      success: true,
      data: serializeUser(user)
    });
  } catch (error) {
    console.error('❌ Get profile failed:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch profile. Please try again.'
    });
  }
};

// @desc    Update user profile
// @route   PUT /api/auth/profile
// @access  Private
exports.updateProfile = async (req, res) => {
  try {
    console.log('📝 Profile update request received');
    console.log('👤 User ID:', req.user._id);
    console.log('📦 Request body:', JSON.stringify(req.body, null, 2));
    
    const { 
      fullName, 
      phone, 
      location, 
      dateOfBirth, 
      gender,
      medicalHistory,
      hasDrugAllergy,
      drugAllergies,
      dietaryPreferences,
      smoking,
      drinking,
      additionalInfo
    } = req.body;
    logger.debug('Update profile request', { userId: req.user._id, bodyKeys: Object.keys(req.body) });
    
    // Build update object with only provided fields
    const updateData = {};
    if (fullName !== undefined) updateData.fullName = fullName;
    if (phone !== undefined) updateData.phone = phone;
    if (location !== undefined) updateData.location = location;
    if (dateOfBirth !== undefined) updateData.dateOfBirth = dateOfBirth;
    if (gender !== undefined) updateData.gender = gender;
    if (medicalHistory !== undefined) updateData.medicalHistory = medicalHistory;
    if (drugAllergies !== undefined) updateData.drugAllergies = drugAllergies;
    if (hasDrugAllergy !== undefined) updateData.hasDrugAllergy = hasDrugAllergy === true || hasDrugAllergy === 'true';
    if (dietaryPreferences !== undefined) updateData.dietaryPreferences = dietaryPreferences;
    if (smoking !== undefined) updateData.smoking = smoking;
    if (drinking !== undefined) updateData.drinking = drinking;
    if (additionalInfo !== undefined) updateData.additionalInfo = additionalInfo;

    logger.debug('Updating user profile', { userId: req.user._id });

    // First, verify user exists
    const existingUser = await User.findById(req.user._id);
    if (!existingUser) {
      logger.warn('User not found for profile update', { userId: req.user._id });
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (updateData.phone && updateData.phone !== existingUser.phone) {
      const phoneOwner = await User.exists({
        phone: updateData.phone,
        _id: { $ne: existingUser._id },
      });
      if (phoneOwner) {
        return res.status(409).json({
          success: false,
          message: 'Phone number already registered',
        });
      }
    }

    // Only validate gender if it's being updated to a non-empty value
    const validGenders = ['Male', 'Female', 'Other'];
    if (updateData.gender && updateData.gender.length > 0 && !validGenders.includes(updateData.gender)) {
      console.log('⚠️  Invalid gender value:', updateData.gender);
      return res.status(400).json({
        success: false,
        message: `Invalid gender. Must be one of: ${validGenders.join(', ')}`
      });
    }
    
    console.log('✅ Validation passed, updating fields:', Object.keys(updateData));

    // Update fields with markModified to ensure tracking
    Object.keys(updateData).forEach(key => {
      existingUser[key] = updateData[key];
      existingUser.markModified(key);
    });

    // Validate the fields this request changed. Disabling validation here let
    // mobile profile writes put values into MongoDB that the admin/user model
    // could not subsequently read or edit consistently.
    await existingUser.save({ validateModifiedOnly: true });

    logger.info('User profile updated', { userId: req.user._id });

    // Fetch fresh from DB to confirm
    const updatedUser = await User.findById(req.user._id)
      .select('-otp -otpExpiry')
      .lean();

    console.log('✅ MongoDB update complete');
    console.log('💾 Updated user from DB:', {
      id: updatedUser._id,
      fullName: updatedUser.fullName,
      phone: updatedUser.phone,
      location: updatedUser.location,
      dateOfBirth: updatedUser.dateOfBirth,
      gender: updatedUser.gender
    });

    res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      data: serializeUser(updatedUser)
    });
  } catch (error) {
    console.error('❌ Update profile failed:', error);
    console.error('❌ Error name:', error.name);
    console.error('❌ Error message:', error.message);
    if (error.errors) {
      console.error('❌ Validation errors:', JSON.stringify(error.errors, null, 2));
    }
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to update profile. Please try again.',
      errors: error.errors
    });
  }
};

// @desc    Upload profile picture
// @route   POST /api/auth/profile-picture
// @access  Private
exports.uploadProfilePicture = async (req, res) => {
  try {
    console.log('📸 Profile picture upload request received');
    console.log('🔍 Request file:', req.file ? 'File present' : 'No file');
    console.log('🔍 Request body:', req.body);
    console.log('🔍 Content-Type:', req.get('Content-Type'));
    
    if (!req.file) {
      console.log('❌ No file in request');
      return res.status(400).json({
        success: false,
        message: 'Please upload an image file'
      });
    }

    console.log('✅ File details:', {
      fieldname: req.file.fieldname,
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size
    });

    const user = await User.findById(req.user._id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const oldProfilePictureId = user.profilePicture?.publicId;

    // Upload and persist the replacement before deleting the old object. The
    // previous order left the database pointing at a deleted image whenever a
    // new upload or S3 request failed halfway through.
    const result = await uploadToCloudinary(req.file.buffer, 'zennara/profiles');

    // Update user profile picture
    user.profilePicture = {
      url: result.secure_url,
      publicId: result.public_id
    };

    await user.save({ validateModifiedOnly: true });

    // Cleanup is best effort and happens only after the new photo is durable.
    if (oldProfilePictureId && oldProfilePictureId !== result.public_id) {
      await deleteFromCloudinary(oldProfilePictureId);
    }

    res.status(200).json({
      success: true,
      message: 'Profile picture uploaded successfully',
      data: {
        profilePicture: user.profilePicture.url
      }
    });
  } catch (error) {
    console.error('❌ Profile picture upload failed:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to upload profile picture. Please try again.',
      error: error.message
    });
  }
};

// @desc    Delete profile picture
// @route   DELETE /api/auth/profile-picture
// @access  Private
exports.deleteProfilePicture = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Delete from S3
    if (user.profilePicture?.publicId) {
      await deleteFromCloudinary(user.profilePicture.publicId);
    }

    // Remove from database
    user.profilePicture = {
      url: null,
      publicId: null
    };

    await user.save({ validateModifiedOnly: true });

    res.status(200).json({
      success: true,
      message: 'Profile picture deleted successfully'
    });
  } catch (error) {
    console.error('❌ Delete profile picture failed');
    res.status(500).json({
      success: false,
      message: 'Failed to delete profile picture. Please try again.'
    });
  }
};

// @desc    Get active sessions
// @route   GET /api/auth/sessions
// @access  Private
exports.getActiveSessions = async (req, res) => {
  try {
    const sessions = await Token.getActiveSessions(req.user._id);
    
    res.status(200).json({
      success: true,
      data: {
        sessions: sessions.map(session => ({
          tokenId: session._id,
          deviceInfo: session.deviceInfo,
          ipAddress: session.ipAddress,
          location: session.location,
          lastUsedAt: session.lastUsedAt,
          createdAt: session.createdAt,
          expiresAt: session.expiresAt,
          isCurrent: session.token === req.headers.authorization?.split(' ')[1]
        })),
        count: sessions.length
      }
    });
  } catch (error) {
    console.error('❌ Get sessions failed:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch sessions.'
    });
  }
};

// @desc    Revoke specific session
// @route   DELETE /api/auth/sessions/:tokenId
// @access  Private
exports.revokeSession = async (req, res) => {
  try {
    const { tokenId } = req.params;
    
    const session = await Token.findOne({
      _id: tokenId,
      userId: req.user._id,
      isActive: true
    });

    if (!session) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }

    await session.revoke();
    
    await SecurityLog.logEvent(req.user._id, 'session_revoked', {
      ipAddress: req.ip,
      metadata: { revokedTokenId: tokenId }
    });

    res.status(200).json({
      success: true,
      message: 'Session revoked successfully'
    });
  } catch (error) {
    console.error('❌ Revoke session failed:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to revoke session.'
    });
  }
};

// @desc    Get security activity log
// @route   GET /api/auth/security-log
// @access  Private
exports.getSecurityLog = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const activity = await SecurityLog.getUserActivity(req.user._id, limit);
    
    res.status(200).json({
      success: true,
      data: {
        activity,
        count: activity.length
      }
    });
  } catch (error) {
    console.error('❌ Get security log failed:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch security log.'
    });
  }
};

// @desc    Check account security status
// @route   GET /api/auth/security-status
// @access  Private
exports.getSecurityStatus = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('-otp -otpExpiry');
    const suspiciousActivity = await SecurityLog.detectSuspiciousActivity(req.user._id);
    const activeSessions = await Token.getActiveSessions(req.user._id);

    res.status(200).json({
      success: true,
      data: {
        emailVerified: user.emailVerified,
        phoneVerified: user.phoneVerified,
        accountLocked: user.accountLockedUntil && user.accountLockedUntil > new Date(),
        lockExpiresAt: user.accountLockedUntil,
        failedLoginAttempts: user.failedLoginAttempts,
        suspiciousActivity: suspiciousActivity.isSuspicious,
        suspiciousDetails: suspiciousActivity,
        activeSessionsCount: activeSessions.length,
        lastLogin: user.lastLogin
      }
    });
  } catch (error) {
    console.error('❌ Get security status failed:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch security status.'
    });
  }
};

// @desc    Get user statistics (appointments, orders, savings)
// @route   GET /api/auth/stats
// @access  Private
exports.getUserStats = async (req, res) => {
  try {
    const userId = req.user._id;
    const user = await User.findById(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Count total appointments (bookings) - ALL statuses
    const appointmentsCount = await Booking.countDocuments({ 
      userId: userId
      // No status filter - count ALL appointments including cancelled and no-show
    });

    // Count total orders (product/medicine orders)
    const ordersCount = await ProductOrder.countDocuments({ 
      userId: userId,
      orderStatus: { $nin: ['Cancelled', 'Refunded'] } // Exclude cancelled and refunded
    });

    // Calculate total savings from treatment packages (Zen Members only)
    let totalSavings = 0;

    if (user.memberType === 'Zen Member') {
      // Calculate savings from treatment package assignments
      const packageAssignments = await PackageAssignment.find({ 
        userId: userId,
        status: { $nin: ['Cancelled'] }, // Exclude cancelled packages
        'pricing.isZenMemberDiscount': true // Only count Zen member discounts
      }).select('pricing');

      // Sum up all discount amounts from packages
      totalSavings = packageAssignments.reduce((sum, assignment) => {
        return sum + (assignment.pricing?.discountAmount || 0);
      }, 0);

      console.log(`💰 Total savings calculated for Zen Member: ₹${totalSavings} from ${packageAssignments.length} packages`);
    }

    res.status(200).json({
      success: true,
      data: {
        appointments: appointmentsCount,
        orders: ordersCount,
        savings: Math.round(totalSavings), // Round to nearest rupee
        memberType: user.memberType
      }
    });

  } catch (error) {
    console.error('❌ Get user stats failed:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch user statistics.'
    });
  }
};

// @desc    Delete user account (GDPR Compliance)
// @route   DELETE /api/auth/account
// @access  Private
exports.deleteAccount = async (req, res) => {
  try {
    const userId = req.user._id;
    const { confirmationText, reason } = req.body;

    // Verify confirmation text
    if (confirmationText !== 'DELETE MY ACCOUNT') {
      return res.status(400).json({
        success: false,
        message: 'Please type "DELETE MY ACCOUNT" to confirm'
      });
    }

    // Find user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    console.log(`🗑️ Account deletion requested by: ${user.email} (${user.fullName})`);

    // Log security event before the user row disappears.
    await SecurityLog.create({
      userId: userId,
      eventType: 'account_deletion',
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      success: true,
      metadata: {
        reason: reason || 'Not provided',
        email: user.email,
        phone: user.phone,
        memberType: user.memberType
      },
      severity: 'high'
    });

    if (user.profilePicture?.publicId) {
      try {
        await deleteFromCloudinary(user.profilePicture.publicId);
      } catch (error) {
        console.error('⚠️ Failed to delete profile picture:', error);
      }
    }

    // Archive everything first, then scrub the live collections — see
    // services/accountDeletionService.js. Staff can restore from the archive.
    const archive = await accountDeletion.deleteAccount({
      userId,
      deletedBy: 'user',
      reason: reason || '',
    });
    console.log(`🗄️ Archived as ${archive._id}`);

    console.log(`✅ Account deleted successfully: ${user.email}`);

    res.status(200).json({
      success: true,
      message: 'Your account has been permanently deleted. We\'re sorry to see you go.'
    });

  } catch (error) {
    console.error('❌ Account deletion failed:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete account. Please try again or contact support.'
    });
  }
};

// @desc    Export all user data (DPDPA 2023 - Right to Data Portability)
// @route   GET /api/auth/export-data
// @access  Private
/**
 * Assemble a user's full data export (the DPDPA data-access payload).
 * Shared by the download endpoint and the "email me my data" endpoint so the
 * two never drift apart. Returns `null` if the user no longer exists.
 */
const buildUserExport = async (userId) => {
    // Gather all user-related data
    const user = await User.findById(userId)
      .select('-otp -otpExpiry -__v')
      .lean();

    if (!user) return null;

    // Get all related data
    const Address = require('../models/Address');
    const PreConsultForm = require('../models/PreConsultForm');
    const Review = require('../models/Review');

    const [addresses, bookings, orders, packageAssignments, healthForms, securityLogs, reviews] = await Promise.all([
      Address.find({ userId }).lean(),
      Booking.find({ userId }).lean(),
      ProductOrder.find({ userId }).lean(),
      PackageAssignment.find({ userId }).lean(),
      PreConsultForm.find({ userId }).lean(),
      SecurityLog.find({ userId }).sort({ createdAt: -1 }).limit(50).lean(),
      Review.find({ userId }).lean()
    ]);

    // Compile export data
    const exportData = {
      exportInfo: {
        exportedAt: new Date().toISOString(),
        exportedBy: user.email,
        dataProtectionNotice: 'This data export is provided under DPDPA 2023 (Digital Personal Data Protection Act, 2023) and IT Act 2000.',
        retentionPolicy: 'Data is retained for 3 years as per Clinical Establishments Act requirements.'
      },
      personalInformation: {
        patientId: user.patientId,
        fullName: user.fullName,
        email: publicEmail(user.email),
        phone: user.phone,
        dateOfBirth: user.dateOfBirth,
        gender: user.gender,
        location: user.location,
        profilePicture: user.profilePicture?.url || null,
        memberType: user.memberType,
        zenMembership: {
          startDate: user.zenMembershipStartDate,
          expiryDate: user.zenMembershipExpiryDate,
          autoRenew: user.zenMembershipAutoRenew
        },
        accountCreated: user.createdAt,
        lastLogin: user.lastLogin
      },
      consentRecords: {
        privacyPolicy: user.privacyPolicyConsent,
        termsOfService: user.termsOfServiceConsent,
        dataRetention: user.dataRetentionConsent
      },
      addresses: addresses.map(addr => ({
        label: addr.label,
        fullName: addr.fullName,
        phone: addr.phone,
        addressLine1: addr.addressLine1,
        addressLine2: addr.addressLine2,
        city: addr.city,
        state: addr.state,
        postalCode: addr.postalCode,
        country: addr.country,
        isDefault: addr.isDefault,
        createdAt: addr.createdAt
      })),
      appointments: bookings.map(booking => ({
        referenceNumber: booking.referenceNumber,
        consultationType: booking.consultationId,
        status: booking.status,
        location: booking.preferredLocation,
        date: booking.preferredDate,
        confirmedDate: booking.confirmedDate,
        confirmedTime: booking.confirmedTime,
        rating: booking.rating,
        feedback: booking.feedback,
        createdAt: booking.createdAt
      })),
      orders: orders.map(order => ({
        orderNumber: order.orderNumber,
        items: order.items.map(item => ({
          productName: item.productName,
          quantity: item.quantity,
          price: item.price
        })),
        total: order.pricing?.total,
        status: order.orderStatus,
        paymentMethod: order.paymentMethod,
        paymentStatus: order.paymentStatus,
        deliveryDate: order.deliveryDate,
        createdAt: order.createdAt
      })),
      treatmentPackages: packageAssignments.map(pkg => ({
        packageName: pkg.packageId,
        status: pkg.status,
        sessionsTotal: pkg.sessions?.total,
        sessionsCompleted: pkg.sessions?.completed,
        pricing: pkg.pricing,
        assignedAt: pkg.createdAt
      })),
      healthInformation: healthForms.map(form => ({
        dateOfVisit: form.dateOfVisit,
        reasonForVisit: form.reasonForVisit,
        skinConcerns: form.skinConcerns,
        hairConcerns: form.hairConcerns,
        medicalHistory: form.medicalHistory,
        allergies: {
          drugAllergies: form.drugAllergies,
          otherAllergies: form.otherAllergies
        },
        diet: form.diet,
        maritalStatus: form.maritalStatus,
        status: form.status,
        submittedAt: form.createdAt
      })),
      reviews: reviews.map(review => ({
        rating: review.rating,
        comment: review.comment,
        createdAt: review.createdAt
      })),
      securityActivity: securityLogs.map(log => ({
        eventType: log.eventType,
        ipAddress: log.ipAddress,
        deviceInfo: log.deviceInfo?.platform,
        success: log.success,
        timestamp: log.createdAt
      })),
      statistics: {
        totalAppointments: bookings.length,
        totalOrders: orders.length,
        totalSpent: user.totalSpent,
        appOpenCount: user.appOpenCount
      }
    };

    return exportData;
};

exports.exportUserData = async (req, res) => {
  try {
    console.log(`📦 Data export requested by user: ${req.user._id}`);
    const exportData = await buildUserExport(req.user._id);
    if (!exportData) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    console.log('✅ Data export compiled successfully');
    res.status(200).json({
      success: true,
      message: 'Your data has been exported successfully',
      data: exportData
    });
  } catch (error) {
    console.error('❌ Data export failed:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to export data. Please try again or contact support.'
    });
  }
};

/**
 * Email the signed-in user their own data export, to the address on file.
 * The data never leaves Zennara except into the user's own inbox.
 */
exports.emailUserData = async (req, res) => {
  try {
    const exportData = await buildUserExport(req.user._id);
    if (!exportData) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const email = exportData.personalInformation?.email;
    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'No email address is on your account. Add one in Personal Information first.'
      });
    }

    await sendDataExportEmail(email, exportData.personalInformation?.fullName, exportData);
    console.log(`📧 Data export emailed to ${email}`);

    res.status(200).json({
      success: true,
      message: `Your data has been emailed to ${email}.`,
      data: { email }
    });
  } catch (error) {
    console.error('❌ Data export email failed:', error);
    res.status(500).json({
      success: false,
      message: 'Could not email your data right now. Please try again or contact support.'
    });
  }
};
