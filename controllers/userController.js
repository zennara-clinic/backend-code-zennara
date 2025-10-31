const User = require('../models/User');

// @desc    Get all patients/users
// @route   GET /api/users
// @access  Private (Admin only)
exports.getAllUsers = async (req, res) => {
  try {
    const { 
      memberType, 
      location, 
      search,
      page = 1,
      limit = 10,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = req.query;

    // Build filter object
    const filter = {};
    
    if (memberType && memberType !== 'All Members') {
      filter.memberType = memberType;
    }
    
    if (location && location !== 'All Locations') {
      filter.location = location;
    }
    
    // Search by name, email, or phone
    if (search) {
      filter.$or = [
        { fullName: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } }
      ];
    }

    // Calculate pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    // Get users with pagination
    const users = await User.find(filter)
      .select('-otp -otpExpiry -__v')
      .sort({ [sortBy]: sortOrder === 'desc' ? -1 : 1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    // Get total count for pagination
    const totalUsers = await User.countDocuments(filter);
    
    // Get statistics
    const totalPatients = await User.countDocuments();
    const zenMembers = await User.countDocuments({ memberType: 'Zen Member' });
    const regularMembers = await User.countDocuments({ memberType: 'Regular Member' });
    
    // Get new users this month
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const newThisMonth = await User.countDocuments({
      createdAt: { $gte: startOfMonth }
    });

    // Format users data
    const formattedUsers = users.map(user => ({
      id: user._id,
      patientId: user.patientId || `PAT${String(user._id).slice(-6).toUpperCase()}`, // Use new patientId or fallback
      name: user.fullName,
      email: user.email,
      phone: user.phone,
      location: user.location,
      memberType: user.memberType,
      dateOfBirth: user.dateOfBirth,
      gender: user.gender,
      profilePhoto: user.profilePicture?.url || null, // Changed to profilePhoto and return null if not exists
      profilePicture: user.profilePicture?.url || null, // Keep for backwards compatibility
      totalVisits: user.appOpenCount || 0, // Now shows app opens instead of clinic visits
      totalSpent: user.totalSpent || 0,
      upcomingAppointments: user.upcomingAppointments || 0,
      isVerified: user.isVerified,
      createdAt: user.createdAt,
      lastLogin: user.lastLogin
    }));

    res.status(200).json({
      success: true,
      data: {
        users: formattedUsers,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(totalUsers / parseInt(limit)),
          totalUsers,
          limit: parseInt(limit)
        },
        statistics: {
          totalPatients,
          zenMembers,
          regularMembers,
          newThisMonth,
          activePatients: totalPatients // Can be calculated based on last login
        }
      }
    });
  } catch (error) {
    console.error('❌ Get all users failed:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch users'
    });
  }
};

// @desc    Get single user by ID
// @route   GET /api/users/:id
// @access  Private (Admin only)
exports.getUserById = async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .select('-otp -otpExpiry -__v')
      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const formattedUser = {
      id: user._id,
      patientId: user.patientId || `PAT${String(user._id).slice(-6).toUpperCase()}`,
      name: user.fullName,
      email: user.email,
      phone: user.phone,
      location: user.location,
      memberType: user.memberType,
      zenMembershipStartDate: user.zenMembershipStartDate,
      zenMembershipExpiryDate: user.zenMembershipExpiryDate,
      zenMembershipAutoRenew: user.zenMembershipAutoRenew,
      dateOfBirth: user.dateOfBirth,
      gender: user.gender,
      profilePhoto: user.profilePicture?.url || null,
      profilePicture: user.profilePicture?.url || null,
      totalVisits: user.appOpenCount || 0, // Now shows app opens instead of clinic visits
      totalSpent: user.totalSpent || 0,
      upcomingAppointments: user.upcomingAppointments || 0,
      isActive: user.isActive !== undefined ? user.isActive : true,
      isVerified: user.isVerified,
      emailVerified: user.emailVerified,
      phoneVerified: user.phoneVerified,
      createdAt: user.createdAt,
      lastLogin: user.lastLogin
    };

    res.status(200).json({
      success: true,
      data: formattedUser
    });
  } catch (error) {
    console.error('❌ Get user by ID failed:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch user'
    });
  }
};

// @desc    Update user
// @route   PUT /api/users/:id
// @access  Private (Admin only)
exports.updateUser = async (req, res) => {
  try {
    const { fullName, phone, location, memberType, dateOfBirth, gender, removeProfilePicture } = req.body;
    const { deleteFromCloudinary } = require('../middleware/upload');

    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Store old profile picture publicId for deletion
    const oldPublicId = user.profilePicture?.publicId;

    // Update fields if provided
    if (fullName) user.fullName = fullName;
    if (phone) user.phone = phone;
    if (location) user.location = location;
    if (memberType) user.memberType = memberType;
    if (dateOfBirth) user.dateOfBirth = dateOfBirth;
    if (gender) user.gender = gender;

    // Handle profile picture removal
    if (removeProfilePicture === 'true' || removeProfilePicture === true) {
      // Delete old image from S3 if it exists
      if (oldPublicId) {
        await deleteFromCloudinary(oldPublicId);
        console.log('🗑️ Deleted old profile picture from S3:', oldPublicId);
      }
      
      user.profilePicture = {
        url: null,
        publicId: null
      };
      console.log('✅ Profile picture removed for user:', user._id);
    }

    // Handle profile picture upload from S3
    if (req.cloudinaryResult) {
      // Delete old image from S3 if it exists
      if (oldPublicId && !removeProfilePicture) {
        await deleteFromCloudinary(oldPublicId);
        console.log('🗑️ Deleted old profile picture from S3:', oldPublicId);
      }

      user.profilePicture = {
        url: req.cloudinaryResult.url,
        publicId: req.cloudinaryResult.publicId
      };
      console.log('✅ Profile picture uploaded to S3 for user:', user._id);
      console.log('📸 S3 URL:', req.cloudinaryResult.url);
    }

    await user.save();

    res.status(200).json({
      success: true,
      message: 'User updated successfully',
      data: {
        id: user._id,
        name: user.fullName,
        email: user.email,
        phone: user.phone,
        location: user.location,
        memberType: user.memberType,
        profilePhoto: user.profilePicture?.url || null
      }
    });
  } catch (error) {
    console.error('❌ Update user failed:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update user',
      error: error.message
    });
  }
};

// @desc    Delete user
// @route   DELETE /api/users/:id
// @access  Private (Admin only)
exports.deleteUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    await user.deleteOne();

    res.status(200).json({
      success: true,
      message: 'User deleted successfully'
    });
  } catch (error) {
    console.error('❌ Delete user failed:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete user'
    });
  }
};

// @desc    Update user statistics
// @route   PATCH /api/users/:id/statistics
// @access  Private (Admin only)
exports.updateUserStatistics = async (req, res) => {
  try {
    const { totalVisits, totalSpent, upcomingAppointments } = req.body;

    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (totalVisits !== undefined) user.totalVisits = totalVisits;
    if (totalSpent !== undefined) user.totalSpent = totalSpent;
    if (upcomingAppointments !== undefined) user.upcomingAppointments = upcomingAppointments;

    await user.save();

    res.status(200).json({
      success: true,
      message: 'User statistics updated successfully',
      data: {
        totalVisits: user.totalVisits,
        totalSpent: user.totalSpent,
        upcomingAppointments: user.upcomingAppointments
      }
    });
  } catch (error) {
    console.error('❌ Update statistics failed:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update statistics'
    });
  }
};

// @desc    Create new user (Admin)
// @route   POST /api/admin/users
// @access  Private (Admin only)
exports.createUser = async (req, res) => {
  try {
    const { email, fullName, phone, location, dateOfBirth, gender, memberType } = req.body;

    // Validate required fields
    if (!email || !fullName || !phone || !location || !dateOfBirth || !gender) {
      return res.status(400).json({
        success: false,
        message: 'All fields are required'
      });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ 
      $or: [{ email: email.toLowerCase() }, { phone }] 
    });

    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: existingUser.email === email.toLowerCase()
          ? 'Email already registered' 
          : 'Phone number already registered'
      });
    }

    // Create new user
    const user = await User.create({
      email: email.toLowerCase(),
      fullName,
      phone,
      location,
      dateOfBirth,
      gender,
      memberType: memberType || 'Regular Member',
      isVerified: true, // Admin-created users are auto-verified
      emailVerified: true,
      phoneVerified: true
    });

    console.log(`✅ User created by admin: ${user.fullName} (${user.patientId})`);

    // Format response
    const formattedUser = {
      id: user._id,
      patientId: user.patientId,
      name: user.fullName,
      email: user.email,
      phone: user.phone,
      location: user.location,
      memberType: user.memberType,
      dateOfBirth: user.dateOfBirth,
      gender: user.gender,
      profilePhoto: user.profilePicture?.url || null,
      isVerified: user.isVerified,
      createdAt: user.createdAt
    };

    res.status(201).json({
      success: true,
      message: 'Patient created successfully',
      data: formattedUser
    });
  } catch (error) {
    console.error('❌ Create user failed:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create patient. Please try again.'
    });
  }
};

// @desc    Assign/Update Zen Membership (Admin)
// @route   POST /api/admin/users/:id/membership
// @access  Private (Admin only)
exports.assignMembership = async (req, res) => {
  try {
    const { months, paymentReceived } = req.body;

    // Validate input
    if (!months || months < 1) {
      return res.status(400).json({
        success: false,
        message: 'Please specify number of months (minimum 1)'
      });
    }

    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const currentDate = new Date();
    const isCurrentlyZenMember = user.memberType === 'Zen Member';

    if (isCurrentlyZenMember && user.zenMembershipExpiryDate) {
      // Extend existing membership
      const currentExpiry = new Date(user.zenMembershipExpiryDate);
      const newExpiry = new Date(currentExpiry);
      newExpiry.setMonth(newExpiry.getMonth() + parseInt(months));
      
      user.zenMembershipExpiryDate = newExpiry;
      
      console.log(`✅ Extended Zen Membership for ${user.fullName} by ${months} month(s). New expiry: ${newExpiry.toDateString()}`);
    } else {
      // Assign new membership
      user.memberType = 'Zen Member';
      user.zenMembershipStartDate = currentDate;
      
      const expiryDate = new Date(currentDate);
      expiryDate.setMonth(expiryDate.getMonth() + parseInt(months));
      user.zenMembershipExpiryDate = expiryDate;
      user.zenMembershipAutoRenew = true;
      
      console.log(`✅ Assigned Zen Membership to ${user.fullName} for ${months} month(s). Expires: ${expiryDate.toDateString()}`);
    }

    await user.save();

    // Format response
    const action = isCurrentlyZenMember ? 'extended' : 'assigned';
    const message = paymentReceived 
      ? `Membership ${action} successfully. Payment of ₹${1999 * months} received.`
      : `Membership ${action} successfully.`;

    res.status(200).json({
      success: true,
      message,
      data: {
        memberType: user.memberType,
        zenMembershipStartDate: user.zenMembershipStartDate,
        zenMembershipExpiryDate: user.zenMembershipExpiryDate,
        zenMembershipAutoRenew: user.zenMembershipAutoRenew
      }
    });
  } catch (error) {
    console.error('❌ Assign membership failed:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to assign membership. Please try again.'
    });
  }
};

// @desc    Cancel Zen Membership (Admin)
// @route   DELETE /api/admin/users/:id/membership
// @access  Private (Admin only)
exports.cancelMembership = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Downgrade to Regular Member and clear membership dates
    user.memberType = 'Regular Member';
    user.zenMembershipStartDate = null;
    user.zenMembershipExpiryDate = null;
    user.zenMembershipAutoRenew = false;

    await user.save();

    res.status(200).json({
      success: true,
      message: 'Zen Membership cancelled successfully',
      data: {
        userId: user._id,
        memberType: user.memberType
      }
    });
  } catch (error) {
    console.error('Cancel membership error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Toggle User Active Status (Deactivate/Activate)
// @route   PATCH /api/admin/users/:id/status
// @access  Private (Admin only)
exports.toggleUserStatus = async (req, res) => {
  try {
    const { isActive } = req.body;
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Update user status
    user.isActive = isActive;
    await user.save();

    // If deactivating, revoke all user sessions/tokens
    if (!isActive) {
      // Import Token model if needed
      const Token = require('../models/Token');
      await Token.revokeAllUserTokens(user._id);
    }

    res.status(200).json({
      success: true,
      message: `User ${isActive ? 'activated' : 'deactivated'} successfully`,
      data: {
        userId: user._id,
        name: user.fullName,
        isActive: user.isActive
      }
    });
  } catch (error) {
    console.error('Toggle user status error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error',
      error: error.message
    });
  }
};

// @desc    Export users data
// @route   GET /api/users/export
// @access  Private (Admin only)
exports.exportUsers = async (req, res) => {
  try {
    const { memberType, location } = req.query;

    const filter = {};
    if (memberType && memberType !== 'All Members') {
      filter.memberType = memberType;
    }
    if (location && location !== 'All Locations') {
      filter.location = location;
    }

    const users = await User.find(filter)
      .select('patientId fullName email phone location memberType dateOfBirth gender totalVisits totalSpent createdAt')
      .lean();

    const formattedData = users.map(user => ({
      'Patient ID': user.patientId || `PAT${String(user._id).slice(-6).toUpperCase()}`,
      'Full Name': user.fullName,
      'Email': user.email,
      'Phone': user.phone,
      'Location': user.location,
      'Member Type': user.memberType,
      'Date of Birth': user.dateOfBirth,
      'Gender': user.gender,
      'Total Visits': user.totalVisits || 0,
      'Total Spent': user.totalSpent || 0,
      'Registered On': new Date(user.createdAt).toLocaleDateString()
    }));

    res.status(200).json({
      success: true,
      data: formattedData
    });
  } catch (error) {
    console.error('❌ Export users failed:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to export users'
    });
  }
};
