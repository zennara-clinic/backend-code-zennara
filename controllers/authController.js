const User = require('../models/User');
const Token = require('../models/Token');
const SecurityLog = require('../models/SecurityLog');
const Booking = require('../models/Booking');
const ProductOrder = require('../models/ProductOrder');
const PackageAssignment = require('../models/PackageAssignment');
const jwt = require('jsonwebtoken');
const { sendOTPEmail, sendWelcomeEmail } = require('../utils/emailService');
const { uploadToCloudinary, deleteFromCloudinary } = require('../middleware/upload');

// @desc    Register new user
// @route   POST /api/auth/signup
// @access  Public
exports.signup = async (req, res) => {
  try {
    const { email, fullName, phone, location, dateOfBirth, gender } = req.body;

    // Check if all required fields are present
    if (!email || !fullName || !phone || !location || !dateOfBirth || !gender) {
      return res.status(400).json({
        success: false,
        message: 'Please provide all required fields'
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

    // Create new user with Regular Member as default
    const user = await User.create({
      email,
      fullName,
      phone,
      location,
      dateOfBirth,
      gender,
      memberType: 'Regular Member' // All new users start as Regular Members
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

    // Send OTP via email
    try {
      await sendOTPEmail(user.email, user.fullName, otp, user.location);
      
      res.status(200).json({
        success: true,
        message: 'OTP sent successfully to your email',
        data: {
          email: user.email,
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

    // Send OTP via email
    try {
      await sendOTPEmail(user.email, user.fullName, otp, user.location);
      
      res.status(200).json({
        success: true,
        message: 'OTP resent successfully',
        data: {
          email: user.email,
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
    const { fullName, phone, location, dateOfBirth, gender } = req.body;
    console.log('📥 RAW Request body:', req.body);
    console.log('📥 Update profile request:', { fullName, phone, location, dateOfBirth, gender });
    console.log('📊 Data types:', {
      fullName: typeof fullName,
      phone: typeof phone,
      location: typeof location,
      dateOfBirth: typeof dateOfBirth,
      gender: typeof gender
    });
    console.log('👤 User ID:', req.user._id);
    
    // Build update object with only provided fields
    const updateData = {};
    if (fullName !== undefined) updateData.fullName = fullName;
    if (phone !== undefined) updateData.phone = phone;
    if (location !== undefined) updateData.location = location;
    if (dateOfBirth !== undefined) updateData.dateOfBirth = dateOfBirth;
    if (gender !== undefined) updateData.gender = gender;

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

    // Delete old profile picture from Cloudinary if exists
    if (user.profilePicture?.publicId) {
      await deleteFromCloudinary(user.profilePicture.publicId);
    }

    // Upload new image to Cloudinary
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

    // Delete from Cloudinary
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

    // Count total appointments (bookings)
    const appointmentsCount = await Booking.countDocuments({ 
      userId: userId,
      status: { $nin: ['Cancelled', 'No Show'] } // Exclude cancelled and no-show
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
