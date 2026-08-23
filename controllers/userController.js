const User = require('../models/User');
const { buildUserFilter } = require('../utils/listFilters');
const DeletedAccountArchive = require('../models/DeletedAccountArchive');
const accountDeletion = require('../services/accountDeletionService');

// @desc    Get all patients/users
// @route   GET /api/users
// @access  Private (Admin only)
exports.getAllUsers = async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;

    // All filtering/sorting lives in utils/listFilters so the export endpoint
    // produces exactly what the list shows.
    const { filter, sort } = await buildUserFilter(req.query);

    // Calculate pagination
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    // Get users with pagination
    const users = await User.find(filter)
      .select('-otp -otpExpiry -__v')
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    // Get total count for pagination
    const totalUsers = await User.countDocuments(filter);
    
    // Get statistics
    const totalPatients = await User.countDocuments();
    const zenMembers = await User.countDocuments({ memberType: 'Zen Member' });
    const regularMembers = await User.countDocuments({ memberType: 'Regular Member' });
    const clinicCustomers = await User.countDocuments({ source: 'zenoti' });
    
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
      _id: user._id,
      patientId: user.patientId || `PAT${String(user._id).slice(-6).toUpperCase()}`, // Use new patientId or fallback
      name: user.fullName,
      fullName: user.fullName,
      email: user.email,
      phone: user.phone,
      location: user.location,
      memberType: user.memberType,
      dateOfBirth: user.dateOfBirth,
      gender: user.gender,
      profilePhoto: user.profilePicture?.url || null, // Changed to profilePhoto and return null if not exists
      profilePicture: user.profilePicture?.url || null, // Keep for backwards compatibility
      totalVisits: user.totalVisits || 0,
      appOpenCount: user.appOpenCount || 0,
      totalSpent: user.totalSpent || 0,
      upcomingAppointments: user.upcomingAppointments || 0,
      hasDrugAllergy: user.hasDrugAllergy === true,
      drugAllergies: user.drugAllergies || '',
      medicalHistory: user.medicalHistory || '',
      isActive: user.isActive !== undefined ? user.isActive : true,
      isVerified: user.isVerified,
      source: user.source || 'app',
      zenMembershipStartDate: user.zenMembershipStartDate || null,
      zenMembershipExpiryDate: user.zenMembershipExpiryDate || null,
      smoking: user.smoking ?? null,
      drinking: user.drinking ?? null,
      zenotiGuestId: user.zenotiGuestId || null,
      zenotiSyncedAt: user.zenotiSyncedAt || null,
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
          clinicCustomers,
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
      _id: user._id,
      patientId: user.patientId || `PAT${String(user._id).slice(-6).toUpperCase()}`,
      name: user.fullName,
      fullName: user.fullName,
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
      totalVisits: user.totalVisits || 0,
      appOpenCount: user.appOpenCount || 0,
      totalSpent: user.totalSpent || 0,
      upcomingAppointments: user.upcomingAppointments || 0,
      hasDrugAllergy: user.hasDrugAllergy === true,
      drugAllergies: user.drugAllergies || '',
      medicalHistory: user.medicalHistory || '',
      source: user.source,
      zenotiGuestId: user.zenotiGuestId || null,
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
    const { fullName, phone, email, location, memberType, dateOfBirth, gender, drugAllergies, hasDrugAllergy, medicalHistory, removeProfilePicture } = req.body;
    const { deleteFromCloudinary } = require('../middleware/upload');

    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (phone && phone !== user.phone) {
      const phoneOwner = await User.exists({
        phone,
        _id: { $ne: user._id },
      });
      if (phoneOwner) {
        return res.status(409).json({
          success: false,
          message: 'Phone number already registered',
        });
      }
    }

    // Store old profile picture publicId for deletion
    const oldPublicId = user.profilePicture?.publicId;

    // Update fields if provided
    if (fullName) user.fullName = fullName;
    if (phone) user.phone = phone;
    if (email && email !== user.email) {
      const emailOwner = await User.findOne({ email: String(email).toLowerCase().trim(), _id: { $ne: user._id } });
      if (emailOwner) {
        return res.status(400).json({ success: false, message: 'That email is already used by another patient' });
      }
      user.email = String(email).toLowerCase().trim();
    }
    if (drugAllergies !== undefined) user.drugAllergies = drugAllergies;
    if (hasDrugAllergy !== undefined) user.hasDrugAllergy = hasDrugAllergy === true || hasDrugAllergy === 'true';
    if (medicalHistory !== undefined) user.medicalHistory = medicalHistory;
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
        _id: user._id,
        name: user.fullName,
        fullName: user.fullName,
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
    // Same archive-then-scrub path as a self-service deletion, so the
    // account can be restored from "Deleted accounts".
    const archive = await accountDeletion.deleteAccount({
      userId: req.params.id,
      deletedBy: 'admin',
      reason: String(req.body?.reason || ''),
      adminId: req.admin?._id || null,
    });

    res.status(200).json({
      success: true,
      message: 'User deleted and archived',
      data: { archiveId: archive._id },
    });
  } catch (error) {
    console.error('❌ Delete user failed:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.status ? error.message : 'Failed to delete user',
    });
  }
};

// @desc    Deleted accounts (restorable archive)
// @route   GET /api/admin/users/deleted
// @access  Private (Admin only)
exports.getDeletedAccounts = async (req, res) => {
  try {
    const { search, includeRestored } = req.query;
    const filter = {};
    if (includeRestored !== 'true') filter.restoredAt = null;
    if (search) {
      const rx = new RegExp(String(search).trim(), 'i');
      filter.$or = [{ email: rx }, { phone: rx }, { fullName: rx }, { patientId: rx }];
    }
    const rows = await DeletedAccountArchive.find(filter)
      .select('-snapshot')
      .sort({ deletedAt: -1 })
      .limit(200)
      .lean();
    res.status(200).json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    console.error('❌ List deleted accounts failed:', error);
    res.status(500).json({ success: false, message: 'Failed to load deleted accounts' });
  }
};

// @desc    Restore a deleted account from its archive
// @route   POST /api/admin/users/deleted/:archiveId/restore
// @access  Private (Admin only)
exports.restoreDeletedAccount = async (req, res) => {
  try {
    const archive = await accountDeletion.restoreAccount({
      archiveId: req.params.archiveId,
      adminId: req.admin?._id || null,
    });
    res.status(200).json({
      success: true,
      message: `Restored ${archive.fullName || archive.email}`,
      data: { userId: archive.originalUserId },
    });
  } catch (error) {
    console.error('❌ Restore account failed:', error);
    res.status(error.status || 500).json({
      success: false,
      message: error.status ? error.message : 'Failed to restore account',
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
      _id: user._id,
      patientId: user.patientId,
      name: user.fullName,
      fullName: user.fullName,
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
    const {
      months, startDate, paymentMethod, amount, paymentReceived, autoRenew, plan, notes, transactionId,
    } = req.body || {};

    const m = parseInt(months, 10);
    if (!m || m < 1 || m > 60) {
      return res.status(400).json({ success: false, message: 'Please specify the number of months (1–60).' });
    }
    const METHODS = ['Paid at clinic', 'Pay at clinic', 'Razorpay', 'Cash', 'Card', 'Credit Card', 'Debit Card', 'UPI', 'Bank Transfer', 'Complimentary'];
    if (!paymentMethod || !METHODS.includes(paymentMethod)) {
      return res.status(400).json({ success: false, message: `Choose how this membership is paid: ${METHODS.join(', ')}.` });
    }
    const amt = Number(amount);
    if (paymentMethod !== 'Complimentary' && (!Number.isFinite(amt) || amt < 0)) {
      return res.status(400).json({ success: false, message: 'Enter the membership amount before granting it.' });
    }
    const received = paymentMethod === 'Complimentary' ? true : paymentMethod === 'Pay at clinic' ? false : paymentReceived !== false;
    // Money taken → a receipt / transaction number is required (cash excepted).
    if (received && paymentMethod !== 'Complimentary' && !/cash/i.test(paymentMethod) && !(transactionId || '').trim()) {
      return res.status(400).json({ success: false, message: 'Enter the receipt / transaction number for this payment (required unless paid in cash).' });
    }

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const now = new Date();
    const isCurrentlyZenMember = user.memberType === 'Zen Member' && user.zenMembershipExpiryDate && new Date(user.zenMembershipExpiryDate) > now;
    let start;
    if (isCurrentlyZenMember) {
      // Extend from the current expiry, never from today.
      start = new Date(user.zenMembershipExpiryDate);
    } else {
      start = startDate ? new Date(startDate) : now;
      if (Number.isNaN(start.getTime())) start = now;
      user.zenMembershipStartDate = start;
    }
    const expiry = new Date(start);
    expiry.setMonth(expiry.getMonth() + m);

    // Record the money like an app purchase so the dashboard counts it.
    const Payment = require('../models/Payment');
    let payment = null;
    if (paymentMethod !== 'Complimentary') {
      payment = await Payment.create({
        userId: user._id,
        orderId: user._id,
        orderType: 'ZenMembership',
        razorpayOrderId: `ADMIN-${user._id}-${Date.now()}`,
        amount: amt,
        currency: 'INR',
        status: received ? 'captured' : 'pending',
        method: paymentMethod,
        metadata: {
          membershipType: 'Zen Member', months: m, plan: plan || null, source: 'admin',
          grantedBy: req.admin ? req.admin.name : null, notes: notes || null, transactionId: transactionId || null,
          membershipActivated: true, startDate: start, expiryDate: expiry,
        },
      });
    }

    user.memberType = 'Zen Member';
    user.zenMembershipExpiryDate = expiry;
    user.zenMembershipAutoRenew = autoRenew === true;
    user.zenMembershipSource = 'admin';
    user.zenMembershipPlan = plan || `Zen Membership · ${m} month${m === 1 ? '' : 's'}`;
    user.zenMembershipMonths = m;
    user.zenMembershipAmount = paymentMethod === 'Complimentary' ? 0 : amt;
    user.zenMembershipPaymentMethod = paymentMethod;
    user.zenMembershipPaymentStatus = received ? 'paid' : 'pending';
    user.zenMembershipPaymentId = payment ? payment._id : null;
    user.zenMembershipGrantedBy = req.admin ? req.admin.name : null;
    await user.save({ validateModifiedOnly: true });

    const action = isCurrentlyZenMember ? 'extended' : 'granted';
    res.status(200).json({
      success: true,
      message: `Zen membership ${action} for ${m} month${m === 1 ? '' : 's'} — ${received ? 'paid' : 'to be paid at the clinic'}.`,
      data: {
        memberType: user.memberType,
        zenMembershipStartDate: user.zenMembershipStartDate,
        zenMembershipExpiryDate: user.zenMembershipExpiryDate,
        zenMembershipAutoRenew: user.zenMembershipAutoRenew,
        zenMembershipPaymentStatus: user.zenMembershipPaymentStatus,
        paymentId: payment ? payment._id : null,
      },
    });
  } catch (error) {
    console.error('❌ Assign membership failed:', error);
    res.status(500).json({ success: false, message: 'Failed to assign membership. Please try again.' });
  }
};

// @desc    Mark a pending (pay-at-clinic) membership as paid
// @route   POST /api/admin/users/:id/membership/paid
exports.markMembershipPaid = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (user.memberType !== 'Zen Member') return res.status(400).json({ success: false, message: 'This guest is not a Zen member.' });
    const { paymentMethod, transactionId } = req.body || {};
    const Payment = require('../models/Payment');
    if (user.zenMembershipPaymentId) {
      await Payment.updateOne({ _id: user.zenMembershipPaymentId }, { $set: { status: 'captured', method: paymentMethod || user.zenMembershipPaymentMethod, 'metadata.transactionId': transactionId || null, 'metadata.paidAt': new Date() } });
    }
    user.zenMembershipPaymentStatus = 'paid';
    if (paymentMethod) user.zenMembershipPaymentMethod = paymentMethod;
    await user.save({ validateModifiedOnly: true });
    res.json({ success: true, message: 'Membership marked as paid.', data: { zenMembershipPaymentStatus: 'paid' } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to update the membership payment.' });
  }
};

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
    // No body means "flip it"; an explicit boolean sets it.
    let { isActive } = req.body || {};
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Update user status
    if (typeof isActive !== 'boolean') isActive = !(user.isActive !== false);
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
        fullName: user.fullName,
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
    const { filter, sort } = await buildUserFilter(req.query);
    const limit = Math.min(20000, Math.max(1, parseInt(req.query.limit || '20000', 10)));

    const users = await User.find(filter)
      .select('patientId fullName email phone location memberType zenMembershipStartDate zenMembershipExpiryDate dateOfBirth gender source totalVisits totalSpent appOpenCount hasDrugAllergy drugAllergies medicalHistory smoking drinking isActive isVerified createdAt lastLogin')
      .sort(sort)
      .limit(limit)
      .lean();

    const fmtDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
    const age = (dob) => { if (!dob) return ''; const d = new Date(dob); if (Number.isNaN(d.getTime())) return ''; const t = new Date(); let a = t.getFullYear() - d.getFullYear(); if (t < new Date(t.getFullYear(), d.getMonth(), d.getDate())) a -= 1; return a; };
    const formattedData = users.map(user => ({
      'Patient ID': user.patientId || `PAT${String(user._id).slice(-6).toUpperCase()}`,
      'Full Name': user.fullName,
      'Email': /@guest\.zennara\.in$/i.test(user.email || '') ? '' : user.email,
      'Phone': user.phone,
      'Centre': user.location || '',
      'Source': user.source === 'zenoti' ? 'Clinic (Zenoti)' : 'App',
      'Member Type': user.memberType,
      'Zen Since': fmtDate(user.zenMembershipStartDate),
      'Zen Expires': fmtDate(user.zenMembershipExpiryDate),
      'Gender': user.gender || '',
      'Date of Birth': fmtDate(user.dateOfBirth),
      'Age': age(user.dateOfBirth),
      'Total Visits': user.totalVisits || 0,
      'Total Spent': user.totalSpent || 0,
      'App Opens': user.appOpenCount || 0,
      'Drug Allergy': user.hasDrugAllergy ? 'Yes' : (user.drugAllergies ? 'Yes' : 'No'),
      'Drug Allergies': user.drugAllergies || '',
      'Medical History': user.medicalHistory || '',
      'Smoking': user.smoking ?? '',
      'Drinking': user.drinking ?? '',
      'Active': user.isActive === false ? 'No' : 'Yes',
      'Verified': user.isVerified ? 'Yes' : 'No',
      'Registered On': fmtDate(user.createdAt),
      'Last Login': fmtDate(user.lastLogin),
    }));

    // `fields` (comma-separated column labels) trims the CSV to what staff picked.
    const fields = String(req.query.fields || '').split(',').map((f) => f.trim()).filter(Boolean);
    const rows = fields.length
      ? formattedData.map((r) => Object.fromEntries(fields.filter((f) => f in r).map((f) => [f, r[f]])))
      : formattedData;

    res.status(200).json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    console.error('❌ Export users failed:', error);
    res.status(500).json({ success: false, message: 'Failed to export users' });
  }
};
