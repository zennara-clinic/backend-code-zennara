const User = require('../models/User');
const Token = require('../models/Token');
const SecurityLog = require('../models/SecurityLog');
const Booking = require('../models/Booking');
const ProductOrder = require('../models/ProductOrder');
const PackageAssignment = require('../models/PackageAssignment');
const jwt = require('jsonwebtoken');
const { sendOTPEmail, sendWelcomeEmail } = require('../utils/emailService');
const { uploadToCloudinary, deleteFromCloudinary } = require('../middleware/upload');
const whatsappService = require('../services/whatsappService');

// @desc    Register new user
// @route   POST /api/auth/signup
// @access  Public
exports.signup = async (req, res) => {
  try {
    const { 
      email, 
      fullName, 
      phone, 
      location, 
      dateOfBirth, 
      gender,
      privacyPolicyAccepted,
      termsAccepted 
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
      privacyPolicyConsent: {
        accepted: true,
        version: '1.0',
        acceptedAt: new Date(),
        ipAddress: ipAddress
      },
      termsOfServiceConsent: {
        accepted: true,
        version: '1.0',
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
      console.error('❌ Failed to send welcome email:', err);
      // Don't fail registration if email fails
    });

    console.log('✅ User registered successfully');

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
    console.error('❌ Registration failed');
    res.status(500).json({
      success: false,
      message: 'Registration failed. Please try again.'
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

    console.log(`✅ User upgraded to Zen Member: ${user.fullName} (Expires: ${expiryDate.toDateString()})`);

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
    const { email } = req.body;

    // Validate email
    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Please provide email address'
      });
    }

    // Find user by email
    const user = await User.findOne({ email: email.toLowerCase() });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'No account found with this email. Please sign up first.'
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

    // Send OTP via email and WhatsApp
    try {
      // Send OTP via email
      await sendOTPEmail(user.email, user.fullName, otp, user.location);
      console.log('📧 OTP email sent to:', user.email);
      
      // Send OTP via WhatsApp (non-blocking)
      if (user.phone) {
        try {
          const whatsappResult = await whatsappService.sendOTP(user.phone, otp, 5);
          
          if (whatsappResult.success) {
            console.log('📱 OTP WhatsApp sent to:', user.phone);
            console.log('   Message SID:', whatsappResult.messageSid);
            console.log('   Using approved template: zennara_otp_v2');
          } else {
            console.error('WhatsApp OTP failed (non-blocking):', whatsappResult.error);
            console.error('   Error code:', whatsappResult.code);
            console.error('   Phone number:', user.phone);
          }
        } catch (whatsappError) {
          console.error('WhatsApp OTP exception (non-blocking):', whatsappError.message);
          // Don't fail the login if WhatsApp fails - email OTP is primary
        }
      } else {
        console.log('No phone number available for WhatsApp OTP');
      }
      
      res.status(200).json({
        success: true,
        message: 'OTP sent successfully to your email and WhatsApp',
        data: {
          email: user.email,
          phone: user.phone ? `******${user.phone.slice(-4)}` : null,
          expiresIn: '5 minutes'
        }
      });
    } catch (emailError) {
      console.error('Email sending error:', emailError);
      // Clear OTP if email fails
      user.clearOTP();
      await user.save({ validateModifiedOnly: true });
      
      res.status(500).json({
        success: false,
        message: 'Failed to send OTP. Please try again.'
      });
    }
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
    const { email, otp } = req.body;

    // Validate input
    if (!email || !otp) {
      return res.status(400).json({
        success: false,
        message: 'Please provide email and OTP'
      });
    }

    // Find user
    const user = await User.findOne({ email: email.toLowerCase() });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
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
    user.emailVerified = true; // Mark email as verified
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

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

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

    console.log('✅ User logged in successfully');

    res.status(200).json({
      success: true,
      message: 'Login successful',
      data: {
        token,
        expiresAt,
        user: {
          id: user._id,
          email: user.email,
          fullName: user.fullName,
          phone: user.phone,
          location: user.location,
          dateOfBirth: user.dateOfBirth,
          gender: user.gender,
          isVerified: user.isVerified
        }
      }
    });
  } catch (error) {
    console.error('❌ OTP verification failed');
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
    const { email } = req.body;

    // Validate email
    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Please provide email address'
      });
    }

    // Find user
    const user = await User.findOne({ email: email.toLowerCase() });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
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
      console.log('📧 OTP email resent to:', user.email);
      
      // Send OTP via WhatsApp (non-blocking)
      if (user.phone) {
        try {
          const whatsappResult = await whatsappService.sendOTP(user.phone, otp, 5);
          
          if (whatsappResult.success) {
            console.log('📱 OTP WhatsApp resent to:', user.phone);
            console.log('   Message SID:', whatsappResult.messageSid);
            console.log('   Using approved template: zennara_otp_v2');
          } else {
            console.error('WhatsApp OTP resend failed (non-blocking):', whatsappResult.error);
            console.error('   Error code:', whatsappResult.code);
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
          email: user.email,
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
        console.log('✅ Token revoked successfully');
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
    console.log('✅ All tokens revoked successfully');

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
    console.log('🔍 Fetching profile for user:', req.user._id);
    
    // Use lean() to get plain JavaScript object (no Mongoose caching)
    const user = await User.findById(req.user._id)
      .select('-otp -otpExpiry')
      .lean();

    if (!user) {
      console.log('❌ User not found:', req.user._id);
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    console.log('✅ Profile fetched from DB:', {
      fullName: user.fullName,
      phone: user.phone,
      location: user.location,
      dateOfBirth: user.dateOfBirth,
      gender: user.gender,
      memberType: user.memberType
    });

    res.status(200).json({
      success: true,
      data: {
        id: user._id,
        email: user.email,
        fullName: user.fullName,
        phone: user.phone,
        location: user.location,
        dateOfBirth: user.dateOfBirth,
        gender: user.gender,
        memberType: user.memberType,
        zenMembershipStartDate: user.zenMembershipStartDate,
        zenMembershipExpiryDate: user.zenMembershipExpiryDate,
        zenMembershipAutoRenew: user.zenMembershipAutoRenew,
        medicalHistory: user.medicalHistory || '',
        drugAllergies: user.drugAllergies || '',
        dietaryPreferences: user.dietaryPreferences || [],
        smoking: user.smoking || '',
        drinking: user.drinking || '',
        additionalInfo: user.additionalInfo || '',
        profilePicture: user.profilePicture?.url || null,
        isVerified: user.isVerified,
        createdAt: user.createdAt
      }
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
    const { 
      fullName, 
      phone, 
      location, 
      dateOfBirth, 
      gender,
      medicalHistory,
      drugAllergies,
      dietaryPreferences,
      smoking,
      drinking,
      additionalInfo
    } = req.body;
    console.log('📥 RAW Request body:', req.body);
    console.log('📥 Update profile request:', { 
      fullName, 
      phone, 
      location, 
      dateOfBirth, 
      gender,
      medicalHistory,
      drugAllergies,
      dietaryPreferences,
      smoking,
      drinking,
      additionalInfo
    });
    console.log('👤 User ID:', req.user._id);
    
    // Build update object with only provided fields
    const updateData = {};
    if (fullName !== undefined) updateData.fullName = fullName;
    if (phone !== undefined) updateData.phone = phone;
    if (location !== undefined) updateData.location = location;
    if (dateOfBirth !== undefined) updateData.dateOfBirth = dateOfBirth;
    if (gender !== undefined) updateData.gender = gender;
    if (medicalHistory !== undefined) updateData.medicalHistory = medicalHistory;
    if (drugAllergies !== undefined) updateData.drugAllergies = drugAllergies;
    if (dietaryPreferences !== undefined) updateData.dietaryPreferences = dietaryPreferences;
    if (smoking !== undefined) updateData.smoking = smoking;
    if (drinking !== undefined) updateData.drinking = drinking;
    if (additionalInfo !== undefined) updateData.additionalInfo = additionalInfo;

    console.log('🔄 Updating with data:', updateData);
    console.log('🔑 Looking for user with ID:', req.user._id);

    // First, verify user exists
    const existingUser = await User.findById(req.user._id);
    if (!existingUser) {
      console.log('❌ User not found with ID:', req.user._id);
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    console.log('📝 BEFORE UPDATE:', {
      fullName: existingUser.fullName,
      phone: existingUser.phone,
      location: existingUser.location,
      dateOfBirth: existingUser.dateOfBirth,
      gender: existingUser.gender
    });

    // NUCLEAR OPTION: Direct property assignment with markModified
    Object.keys(updateData).forEach(key => {
      existingUser[key] = updateData[key];
      existingUser.markModified(key); // Force Mongoose to track the change
    });

    console.log('💥 AFTER ASSIGNMENT:', {
      fullName: existingUser.fullName,
      phone: existingUser.phone,
      location: existingUser.location,
      dateOfBirth: existingUser.dateOfBirth,
      gender: existingUser.gender
    });

    console.log('🔄 Modified paths:', existingUser.modifiedPaths());

    // Save with validation completely disabled
    const savedUser = await existingUser.save({ 
      validateBeforeSave: false,
      validateModifiedOnly: false 
    });

    console.log('💾 SAVED TO DB:', {
      fullName: savedUser.fullName,
      phone: savedUser.phone,
      location: savedUser.location,
      dateOfBirth: savedUser.dateOfBirth,
      gender: savedUser.gender
    });

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
      data: {
        id: updatedUser._id,
        email: updatedUser.email,
        fullName: updatedUser.fullName,
        phone: updatedUser.phone,
        location: updatedUser.location,
        dateOfBirth: updatedUser.dateOfBirth,
        gender: updatedUser.gender,
        medicalHistory: updatedUser.medicalHistory || '',
        drugAllergies: updatedUser.drugAllergies || '',
        dietaryPreferences: updatedUser.dietaryPreferences || [],
        smoking: updatedUser.smoking || '',
        drinking: updatedUser.drinking || '',
        additionalInfo: updatedUser.additionalInfo || '',
        profilePicture: updatedUser.profilePicture?.url || null
      }
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

    // Delete old profile picture from S3 if exists
    if (user.profilePicture?.publicId) {
      await deleteFromCloudinary(user.profilePicture.publicId);
    }

    // Upload new image to S3
    const result = await uploadToCloudinary(req.file.buffer, 'zennara/profiles');

    // Update user profile picture
    user.profilePicture = {
      url: result.secure_url,
      publicId: result.public_id
    };

    await user.save({ validateModifiedOnly: true });

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
    console.log(`📋 Reason: ${reason || 'Not provided'}`);

    // Automatically cancel all active bookings
    const activeBookingsResult = await Booking.updateMany(
      {
        userId: userId,
        status: { $in: ['Confirmed', 'Pending', 'Awaiting Confirmation'] },
        appointmentDate: { $gte: new Date() }
      },
      {
        $set: {
          status: 'Cancelled',
          cancellationReason: 'Account deleted by user',
          cancelledAt: new Date()
        }
      }
    );
    console.log(`✅ Cancelled ${activeBookingsResult.modifiedCount} active bookings`);

    // Automatically cancel all pending orders
    const pendingOrdersResult = await ProductOrder.updateMany(
      {
        userId: userId,
        orderStatus: { $in: ['Order Placed', 'Confirmed', 'Processing'] }
      },
      {
        $set: {
          orderStatus: 'Cancelled',
          cancellationReason: 'Account deleted by user',
          cancelledAt: new Date()
        }
      }
    );
    console.log(`✅ Cancelled ${pendingOrdersResult.modifiedCount} pending orders`);

    // Note: Orders that are "Shipped" or "Out for Delivery" will be anonymized but not cancelled
    // as they are already in transit and cannot be stopped

    // Log security event
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

    // Delete user's profile picture from Cloudinary
    if (user.profilePicture?.publicId) {
      try {
        await deleteFromCloudinary(user.profilePicture.publicId);
        console.log('✅ Profile picture deleted from Cloudinary');
      } catch (error) {
        console.error('⚠️ Failed to delete profile picture:', error);
      }
    }

    // Delete ALL user-related data
    console.log('🗑️ Deleting all user data...');

    // Delete user tokens
    await Token.deleteMany({ userId: userId });
    console.log('✅ Deleted user tokens');

    // Delete user addresses
    const Address = require('../models/Address');
    await Address.deleteMany({ userId: userId });
    console.log('✅ Deleted user addresses');

    // Delete or anonymize bookings
    // Note: For legal/accounting, we anonymize instead of delete
    await Booking.updateMany(
      { userId: userId },
      { 
        $set: { 
          'contact.email': '[deleted]',
          'contact.phone': '[deleted]',
          notes: '[User account deleted]'
        }
      }
    );
    console.log('✅ Anonymized user bookings');

    // Delete or anonymize orders
    await ProductOrder.updateMany(
      { userId: userId },
      {
        $set: {
          'shippingAddress.fullName': '[deleted]',
          'shippingAddress.phone': '[deleted]',
          'shippingAddress.addressLine1': '[deleted]',
          'shippingAddress.addressLine2': '[deleted]',
        }
      }
    );
    console.log('✅ Anonymized user orders');

    // Delete package assignments if any
    await PackageAssignment.deleteMany({ userId: userId });
    console.log('✅ Deleted package assignments');

    // Finally, delete the user account
    await User.findByIdAndDelete(userId);

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
exports.exportUserData = async (req, res) => {
  try {
    const userId = req.user._id;
    
    console.log(`📦 Data export requested by user: ${userId}`);
    
    // Gather all user-related data
    const user = await User.findById(userId)
      .select('-otp -otpExpiry -__v')
      .lean();
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

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
        email: user.email,
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
