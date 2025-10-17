const PackageAssignment = require('../models/PackageAssignment');
const User = require('../models/User');
const Package = require('../models/Package');
const cloudinary = require('../config/cloudinary');
const { sendOtpEmail } = require('../utils/emailService');

// Get all package assignments with filters and sorting
exports.getAllAssignments = async (req, res) => {
  try {
    const { 
      search, 
      status, 
      memberType, 
      sortBy = 'createdAt', 
      sortOrder = 'desc',
      page = 1,
      limit = 20
    } = req.query;

    const query = {};

    // Search filter
    if (search) {
      query.$or = [
        { 'userDetails.fullName': { $regex: search, $options: 'i' } },
        { 'userDetails.email': { $regex: search, $options: 'i' } },
        { 'userDetails.phone': { $regex: search, $options: 'i' } },
        { 'userDetails.patientId': { $regex: search, $options: 'i' } },
        { assignmentId: { $regex: search, $options: 'i' } }
      ];
    }

    // Status filter
    if (status && status !== 'all') {
      query.status = status;
    }

    // Member type filter
    if (memberType && memberType !== 'all') {
      query['userDetails.memberType'] = memberType;
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const sort = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };

    const assignments = await PackageAssignment.find(query)
      .sort(sort)
      .skip(skip)
      .limit(parseInt(limit))
      .populate('userId', 'fullName email phone patientId memberType')
      .populate('packageId', 'name price originalPrice');

    const total = await PackageAssignment.countDocuments(query);

    res.status(200).json({
      success: true,
      data: assignments,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / parseInt(limit)),
        limit: parseInt(limit)
      }
    });
  } catch (error) {
    console.error('Get assignments error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch package assignments',
      error: error.message
    });
  }
};

// Get single assignment by ID
exports.getAssignmentById = async (req, res) => {
  try {
    const assignment = await PackageAssignment.findById(req.params.id)
      .populate('userId', 'fullName email phone patientId memberType profilePicture')
      .populate('packageId');

    if (!assignment) {
      return res.status(404).json({
        success: false,
        message: 'Package assignment not found'
      });
    }

    res.status(200).json({
      success: true,
      data: assignment
    });
  } catch (error) {
    console.error('Get assignment error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch package assignment',
      error: error.message
    });
  }
};

// Create new package assignment
exports.createAssignment = async (req, res) => {
  try {
    const {
      userId,
      packageId,
      discountPercentage,
      isZenMemberDiscount,
      paymentReceived,
      paymentMethod,
      transactionId,
      notes,
      validUntil
    } = req.body;

    // Validate user exists
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Validate package exists
    const packageData = await Package.findById(packageId);
    if (!packageData) {
      return res.status(404).json({
        success: false,
        message: 'Package not found'
      });
    }

    // Create assignment data
    const assignmentData = {
      userId,
      packageId,
      packageDetails: {
        packageName: packageData.name,
        packagePrice: packageData.price,
        originalPrice: packageData.originalPrice,
        services: packageData.services.map(s => ({
          serviceId: s.serviceId,
          serviceName: s.serviceName
        }))
      },
      userDetails: {
        fullName: user.fullName || user.name,
        name: user.fullName || user.name,
        email: user.email,
        phone: user.phone,
        patientId: user.patientId,
        memberType: user.memberType
      },
      pricing: {
        originalAmount: packageData.price,
        discountPercentage: discountPercentage || 0,
        isZenMemberDiscount: isZenMemberDiscount || false
      },
      payment: {
        isReceived: paymentReceived || false,
        paymentMethod: paymentMethod || null,
        transactionId: transactionId || null
      },
      notes: notes || '',
      validUntil: validUntil || null,
      assignedBy: req.admin?._id || null,
      assignedByName: req.admin?.name || 'Admin'
    };

    const assignment = new PackageAssignment(assignmentData);
    await assignment.save();

    // Populate before sending response
    await assignment.populate('userId', 'fullName email phone patientId memberType');
    await assignment.populate('packageId', 'name price originalPrice');

    res.status(201).json({
      success: true,
      message: 'Package assigned successfully',
      data: assignment
    });
  } catch (error) {
    console.error('Create assignment error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to assign package',
      error: error.message
    });
  }
};

// Upload payment proof
exports.uploadPaymentProof = async (req, res) => {
  try {
    const { id } = req.params;
    
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded'
      });
    }

    const assignment = await PackageAssignment.findById(id);
    if (!assignment) {
      return res.status(404).json({
        success: false,
        message: 'Package assignment not found'
      });
    }

    // Delete old proof if exists
    if (assignment.payment.proofPublicId) {
      try {
        await cloudinary.uploader.destroy(assignment.payment.proofPublicId);
      } catch (err) {
        console.error('Error deleting old payment proof:', err);
      }
    }

    // Upload to cloudinary
    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: 'zennara/payment-proofs',
      resource_type: 'auto'
    });

    assignment.payment.proofUrl = result.secure_url;
    assignment.payment.proofPublicId = result.public_id;
    assignment.payment.isReceived = true;
    assignment.payment.receivedDate = new Date();

    await assignment.save();

    res.status(200).json({
      success: true,
      message: 'Payment proof uploaded successfully',
      data: {
        proofUrl: result.secure_url
      }
    });
  } catch (error) {
    console.error('Upload payment proof error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to upload payment proof',
      error: error.message
    });
  }
};

// Update assignment
exports.updateAssignment = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const assignment = await PackageAssignment.findById(id);
    if (!assignment) {
      return res.status(404).json({
        success: false,
        message: 'Package assignment not found'
      });
    }

    // Update allowed fields
    const allowedUpdates = [
      'status',
      'notes',
      'validUntil',
      'pricing.discountPercentage',
      'payment.isReceived',
      'payment.paymentMethod',
      'payment.transactionId'
    ];

    Object.keys(updates).forEach(key => {
      if (allowedUpdates.includes(key)) {
        if (key.includes('.')) {
          const [parent, child] = key.split('.');
          assignment[parent][child] = updates[key];
        } else {
          assignment[key] = updates[key];
        }
      }
    });

    await assignment.save();

    res.status(200).json({
      success: true,
      message: 'Assignment updated successfully',
      data: assignment
    });
  } catch (error) {
    console.error('Update assignment error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update assignment',
      error: error.message
    });
  }
};

// Delete assignment
exports.deleteAssignment = async (req, res) => {
  try {
    const assignment = await PackageAssignment.findById(req.params.id);
    
    if (!assignment) {
      return res.status(404).json({
        success: false,
        message: 'Package assignment not found'
      });
    }

    // Delete payment proof from cloudinary if exists
    if (assignment.payment.proofPublicId) {
      try {
        await cloudinary.uploader.destroy(assignment.payment.proofPublicId);
      } catch (err) {
        console.error('Error deleting payment proof:', err);
      }
    }

    await PackageAssignment.findByIdAndDelete(req.params.id);

    res.status(200).json({
      success: true,
      message: 'Package assignment deleted successfully'
    });
  } catch (error) {
    console.error('Delete assignment error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete assignment',
      error: error.message
    });
  }
};

// Get assignment statistics
exports.getAssignmentStats = async (req, res) => {
  try {
    const stats = await PackageAssignment.aggregate([
      {
        $facet: {
          statusCounts: [
            {
              $group: {
                _id: '$status',
                count: { $sum: 1 }
              }
            }
          ],
          memberTypeCounts: [
            {
              $group: {
                _id: '$userDetails.memberType',
                count: { $sum: 1 }
              }
            }
          ],
          paymentStats: [
            {
              $match: {
                status: { $ne: 'Cancelled' } // Exclude cancelled packages
              }
            },
            {
              $group: {
                _id: '$payment.isReceived',
                count: { $sum: 1 },
                totalAmount: { $sum: '$pricing.finalAmount' }
              }
            }
          ],
          totalRevenue: [
            {
              $match: {
                status: { $ne: 'Cancelled' } // Exclude cancelled packages from revenue
              }
            },
            {
              $group: {
                _id: null,
                total: { $sum: '$pricing.finalAmount' }
              }
            }
          ]
        }
      }
    ]);

    res.status(200).json({
      success: true,
      data: stats[0]
    });
  } catch (error) {
    console.error('Get stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch statistics',
      error: error.message
    });
  }
};

// Send OTP for service completion
exports.sendServiceOtp = async (req, res) => {
  try {
    const { assignmentId, serviceId, userId } = req.body;

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    
    // Store OTP in assignment (you may want to add this field to the model)
    const assignment = await PackageAssignment.findById(assignmentId);
    if (!assignment) {
      return res.status(404).json({
        success: false,
        message: 'Assignment not found'
      });
    }

    // Get user details
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Store OTP with expiry (5 minutes)
    if (!assignment.serviceOtps) {
      assignment.serviceOtps = new Map();
    }
    assignment.serviceOtps.set(serviceId, {
      otp: otp,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000) // 5 minutes
    });
    await assignment.save();

    // Get service name from assignment
    const service = assignment.packageDetails.services.find(s => s.serviceId === serviceId);
    const serviceName = service ? service.serviceName : 'Service';
    const packageName = assignment.packageDetails.packageName;

    // Send OTP via email
    await sendOtpEmail(user.email, otp, user.fullName || user.name, serviceName, packageName);

    res.status(200).json({
      success: true,
      message: 'OTP sent successfully'
    });
  } catch (error) {
    console.error('Send OTP error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send OTP',
      error: error.message
    });
  }
};

// Verify OTP and mark service as completed
exports.verifyServiceOtp = async (req, res) => {
  try {
    const { assignmentId, serviceId, otp } = req.body;

    const assignment = await PackageAssignment.findById(assignmentId);
    if (!assignment) {
      return res.status(404).json({
        success: false,
        message: 'Assignment not found'
      });
    }

    // Check if OTP exists and is valid
    const storedOtpData = assignment.serviceOtps?.get(serviceId);
    if (!storedOtpData) {
      return res.status(400).json({
        success: false,
        message: 'No OTP found for this service'
      });
    }

    // Check if OTP is expired
    if (new Date() > new Date(storedOtpData.expiresAt)) {
      return res.status(400).json({
        success: false,
        message: 'OTP has expired'
      });
    }

    // Verify OTP
    if (storedOtpData.otp !== otp) {
      return res.status(400).json({
        success: false,
        message: 'Invalid OTP'
      });
    }

    // Mark service as completed
    if (!assignment.completedServices) {
      assignment.completedServices = [];
    }
    
    // Check if service is already completed
    const alreadyCompleted = assignment.completedServices.some(
      cs => cs.serviceId === serviceId
    );

    if (!alreadyCompleted) {
      assignment.completedServices.push({
        serviceId: serviceId,
        completedAt: new Date(),
        prescriptions: []
      });
    }

    // Remove used OTP
    assignment.serviceOtps.delete(serviceId);
    
    // Check if all services are completed and update status
    assignment.checkCompletion();
    await assignment.save();

    res.status(200).json({
      success: true,
      message: 'Service marked as completed',
      isPackageCompleted: assignment.status === 'Completed',
      completionPercentage: assignment.getCompletionPercentage()
    });
  } catch (error) {
    console.error('Verify OTP error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to verify OTP',
      error: error.message
    });
  }
};

// Upload prescription for completed service
exports.uploadPrescription = async (req, res) => {
  try {
    const { id } = req.params;
    const { serviceId, prescriptionUrl } = req.body;

    const assignment = await PackageAssignment.findById(id);
    if (!assignment) {
      return res.status(404).json({
        success: false,
        message: 'Assignment not found'
      });
    }

    // Find the completed service
    const completedService = assignment.completedServices?.find(
      cs => cs.serviceId === serviceId
    );

    if (!completedService) {
      return res.status(400).json({
        success: false,
        message: 'Service not completed yet'
      });
    }

    // Add prescription URL
    if (!completedService.prescriptions) {
      completedService.prescriptions = [];
    }
    completedService.prescriptions.push(prescriptionUrl);

    await assignment.save();

    res.status(200).json({
      success: true,
      message: 'Prescription uploaded successfully',
      data: assignment
    });
  } catch (error) {
    console.error('Upload prescription error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to upload prescription',
      error: error.message
    });
  }
};

// Send OTP for package cancellation
exports.sendCancellationOtp = async (req, res) => {
  try {
    const { id } = req.params;

    const assignment = await PackageAssignment.findById(id);
    if (!assignment) {
      return res.status(404).json({
        success: false,
        message: 'Assignment not found'
      });
    }

    if (assignment.status === 'Cancelled') {
      return res.status(400).json({
        success: false,
        message: 'Package is already cancelled'
      });
    }

    // Get user details
    const user = await User.findById(assignment.userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    
    // Store OTP with expiry (5 minutes)
    assignment.cancellationOtp = {
      otp: otp,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000)
    };
    await assignment.save();

    // Send OTP via email using cancellation template
    const { sendPackageCancellationOtp } = require('../utils/emailService');
    await sendPackageCancellationOtp(
      user.email,
      otp,
      user.fullName || user.name,
      assignment.packageDetails.packageName,
      assignment.assignmentId
    );

    res.status(200).json({
      success: true,
      message: 'Cancellation OTP sent successfully'
    });
  } catch (error) {
    console.error('Send cancellation OTP error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send cancellation OTP',
      error: error.message
    });
  }
};

// Verify OTP and cancel package
exports.verifyCancellationOtp = async (req, res) => {
  try {
    const { id } = req.params;
    const { otp, reason } = req.body;

    const assignment = await PackageAssignment.findById(id);
    if (!assignment) {
      return res.status(404).json({
        success: false,
        message: 'Assignment not found'
      });
    }

    if (assignment.status === 'Cancelled') {
      return res.status(400).json({
        success: false,
        message: 'Package is already cancelled'
      });
    }

    // Check if OTP exists
    if (!assignment.cancellationOtp || !assignment.cancellationOtp.otp) {
      return res.status(400).json({
        success: false,
        message: 'No cancellation OTP found. Please request a new one.'
      });
    }

    // Check if OTP is expired
    if (new Date() > new Date(assignment.cancellationOtp.expiresAt)) {
      return res.status(400).json({
        success: false,
        message: 'OTP has expired. Please request a new one.'
      });
    }

    // Verify OTP
    if (assignment.cancellationOtp.otp !== otp) {
      return res.status(400).json({
        success: false,
        message: 'Invalid OTP'
      });
    }

    // Cancel the package
    assignment.status = 'Cancelled';
    assignment.cancellation = {
      isCancelled: true,
      cancelledAt: new Date(),
      cancelledBy: req.admin?.name || 'Admin',
      reason: reason || 'No reason provided'
    };
    assignment.cancellationOtp = undefined; // Clear the OTP
    
    await assignment.save();

    res.status(200).json({
      success: true,
      message: 'Package cancelled successfully',
      data: assignment
    });
  } catch (error) {
    console.error('Verify cancellation OTP error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to cancel package',
      error: error.message
    });
  }
};

// USER-FACING ENDPOINTS

// @desc    Get user's treatment packages
// @route   GET /api/user/package-assignments
// @access  Private (User)
exports.getUserPackages = async (req, res) => {
  try {
    const userId = req.user._id;

    const assignments = await PackageAssignment.find({ userId })
      .sort({ createdAt: -1 })
      .populate('packageId', 'name description price duration');

    res.status(200).json({
      success: true,
      data: assignments
    });
  } catch (error) {
    console.error('Get user packages error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch your treatment packages',
      error: error.message
    });
  }
};

// @desc    Get single user package by ID
// @route   GET /api/user/package-assignments/:id
// @access  Private (User)
exports.getUserPackageById = async (req, res) => {
  try {
    const userId = req.user._id;
    const assignmentId = req.params.id;

    const assignment = await PackageAssignment.findOne({ 
      _id: assignmentId,
      userId: userId 
    }).populate('packageId');

    if (!assignment) {
      return res.status(404).json({
        success: false,
        message: 'Treatment package not found'
      });
    }

    res.status(200).json({
      success: true,
      data: assignment
    });
  } catch (error) {
    console.error('Get user package error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch treatment package details',
      error: error.message
    });
  }
};
