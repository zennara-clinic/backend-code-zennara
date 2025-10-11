const User = require('../models/User');
const Token = require('../models/Token');
const jwt = require('jsonwebtoken');
const { sendOTPEmail } = require('../utils/emailService');
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

    // Create new user
    const user = await User.create({
      email,
      fullName,
      phone,
      location,
      dateOfBirth,
      gender
    });

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

    // Generate OTP
    const otp = user.generateOTP();
    await user.save({ validateModifiedOnly: true });

    // Send OTP via email
    try {
      await sendOTPEmail(user.email, user.fullName, otp);
      
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

    // Verify OTP
    const isValidOTP = user.verifyOTP(otp);

    if (!isValidOTP) {
      const now = Date.now();
      const expired = user.otpExpiry && now > user.otpExpiry;
      
      return res.status(400).json({
        success: false,
        message: expired ? 'OTP has expired. Please request a new one.' : 'Invalid OTP. Please check and try again.'
      });
    }

    // Update user
    user.isVerified = true;
    user.lastLogin = Date.now();
    user.clearOTP();
    await user.save({ validateModifiedOnly: true });

    // Generate JWT token
    const token = jwt.sign(
      { userId: user._id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE || '7d' }
    );

    // Calculate token expiry (7 days from now)
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    // Save token to database
    const tokenDoc = new Token({
      userId: user._id,
      token,
      type: 'access',
      deviceInfo: {
        platform: req.headers['user-agent'] || 'unknown',
        deviceId: req.headers['device-id'] || null,
        appVersion: req.headers['app-version'] || null
      },
      ipAddress: req.ip || req.connection.remoteAddress,
      expiresAt,
      isActive: true
    });

    await tokenDoc.save();
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

    // Generate new OTP
    const otp = user.generateOTP();
    await user.save({ validateModifiedOnly: true });

    // Send OTP via email
    try {
      await sendOTPEmail(user.email, user.fullName, otp);
      
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
    await Token.revokeAllUserTokens(req.user.userId);
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
    console.log('🔍 Fetching profile for user:', req.user.userId);
    
    // Use lean() to get plain JavaScript object (no Mongoose caching)
    const user = await User.findById(req.user.userId)
      .select('-otp -otpExpiry')
      .lean();

    if (!user) {
      console.log('❌ User not found:', req.user.userId);
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
      gender: user.gender
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
    console.log('👤 User ID:', req.user.userId);
    
    // Build update object with only provided fields
    const updateData = {};
    if (fullName !== undefined) updateData.fullName = fullName;
    if (phone !== undefined) updateData.phone = phone;
    if (location !== undefined) updateData.location = location;
    if (dateOfBirth !== undefined) updateData.dateOfBirth = dateOfBirth;
    if (gender !== undefined) updateData.gender = gender;

    console.log('🔄 Updating with data:', updateData);
    console.log('🔑 Looking for user with ID:', req.user.userId);

    // First, verify user exists
    const existingUser = await User.findById(req.user.userId);
    if (!existingUser) {
      console.log('❌ User not found with ID:', req.user.userId);
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
    const updatedUser = await User.findById(req.user.userId)
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

    const user = await User.findById(req.user.userId);

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
    const user = await User.findById(req.user.userId);

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
