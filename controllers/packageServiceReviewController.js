const PackageServiceReview = require('../models/PackageServiceReview');
const PackageAssignment = require('../models/PackageAssignment');
const User = require('../models/User');

// @desc    Submit a review for a completed package service
// @route   POST /api/package-service-reviews
// @access  Private (User)
exports.submitServiceReview = async (req, res) => {
  try {
    const { packageAssignmentId, serviceId, serviceName, rating, reviewText } = req.body;
    const userId = req.user.id;

    // Validate required fields
    if (!packageAssignmentId || !serviceId || !serviceName || !rating || !reviewText) {
      return res.status(400).json({
        success: false,
        message: 'Please provide all required fields'
      });
    }

    // Validate rating
    if (rating < 1 || rating > 5) {
      return res.status(400).json({
        success: false,
        message: 'Rating must be between 1 and 5'
      });
    }

    // Validate review text length
    if (reviewText.trim().length < 10) {
      return res.status(400).json({
        success: false,
        message: 'Review must be at least 10 characters long'
      });
    }

    if (reviewText.length > 1000) {
      return res.status(400).json({
        success: false,
        message: 'Review cannot exceed 1000 characters'
      });
    }

    // Check if package assignment exists
    const assignment = await PackageAssignment.findOne({ assignmentId: packageAssignmentId });
    if (!assignment) {
      return res.status(404).json({
        success: false,
        message: 'Package assignment not found'
      });
    }

    // Verify user owns this assignment
    if (assignment.userId.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'You are not authorized to review this service'
      });
    }

    // Check if service is completed
    const completedService = assignment.completedServices.find(
      cs => cs.serviceId === serviceId
    );

    if (!completedService) {
      return res.status(400).json({
        success: false,
        message: 'You can only review completed services'
      });
    }

    // Check if user has already reviewed this service
    const existingReview = await PackageServiceReview.findOne({
      userId,
      packageAssignmentId,
      serviceId
    });

    if (existingReview) {
      return res.status(400).json({
        success: false,
        message: 'You have already reviewed this service'
      });
    }

    // Create review
    const review = await PackageServiceReview.create({
      userId,
      packageAssignmentId,
      serviceId,
      serviceName,
      rating,
      reviewText: reviewText.trim()
    });

    console.log(`✅ Package service review created: ${review._id}`);

    res.status(201).json({
      success: true,
      message: 'Review submitted successfully',
      data: review
    });
  } catch (error) {
    console.error('❌ Submit service review error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to submit review'
    });
  }
};

// @desc    Update a service review
// @route   PUT /api/package-service-reviews/:id
// @access  Private (User)
exports.updateServiceReview = async (req, res) => {
  try {
    const { id } = req.params;
    const { rating, reviewText } = req.body;
    const userId = req.user.id;

    // Validate fields if provided
    if (rating !== undefined && (rating < 1 || rating > 5)) {
      return res.status(400).json({
        success: false,
        message: 'Rating must be between 1 and 5'
      });
    }

    if (reviewText !== undefined) {
      if (reviewText.trim().length < 10) {
        return res.status(400).json({
          success: false,
          message: 'Review must be at least 10 characters long'
        });
      }

      if (reviewText.length > 1000) {
        return res.status(400).json({
          success: false,
          message: 'Review cannot exceed 1000 characters'
        });
      }
    }

    // Find review
    const review = await PackageServiceReview.findById(id);
    if (!review) {
      return res.status(404).json({
        success: false,
        message: 'Review not found'
      });
    }

    // Verify ownership
    if (review.userId.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'You are not authorized to update this review'
      });
    }

    // Update fields
    if (rating !== undefined) review.rating = rating;
    if (reviewText !== undefined) review.reviewText = reviewText.trim();
    review.isApproved = false; // Reset approval status on edit

    await review.save();

    console.log(`✅ Package service review updated: ${review._id}`);

    res.status(200).json({
      success: true,
      message: 'Review updated successfully',
      data: review
    });
  } catch (error) {
    console.error('❌ Update service review error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to update review'
    });
  }
};

// @desc    Delete a service review
// @route   DELETE /api/package-service-reviews/:id
// @access  Private (User)
exports.deleteServiceReview = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const review = await PackageServiceReview.findById(id);
    if (!review) {
      return res.status(404).json({
        success: false,
        message: 'Review not found'
      });
    }

    // Verify ownership
    if (review.userId.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'You are not authorized to delete this review'
      });
    }

    await PackageServiceReview.findByIdAndDelete(id);

    console.log(`✅ Package service review deleted: ${id}`);

    res.status(200).json({
      success: true,
      message: 'Review deleted successfully'
    });
  } catch (error) {
    console.error('❌ Delete service review error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to delete review'
    });
  }
};

// @desc    Get user's reviews for their package services
// @route   GET /api/package-service-reviews/my-reviews
// @access  Private (User)
exports.getMyServiceReviews = async (req, res) => {
  try {
    const userId = req.user.id;

    const reviews = await PackageServiceReview.find({ userId })
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      count: reviews.length,
      data: reviews
    });
  } catch (error) {
    console.error('❌ Get my service reviews error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch reviews'
    });
  }
};

// @desc    Get reviews for a specific service
// @route   GET /api/package-service-reviews/service/:serviceId
// @access  Public
exports.getServiceReviews = async (req, res) => {
  try {
    const { serviceId } = req.params;

    const reviews = await PackageServiceReview.find({ 
      serviceId,
      isApproved: true 
    })
      .populate('userId', 'fullName name profilePicture')
      .sort({ createdAt: -1 });

    // Calculate average rating
    const avgRating = reviews.length > 0
      ? reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length
      : 0;

    res.status(200).json({
      success: true,
      count: reviews.length,
      avgRating: avgRating.toFixed(1),
      data: reviews
    });
  } catch (error) {
    console.error('❌ Get service reviews error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch service reviews'
    });
  }
};

// @desc    Check if user can review a service
// @route   GET /api/package-service-reviews/can-review/:packageAssignmentId/:serviceId
// @access  Private (User)
exports.canReviewService = async (req, res) => {
  try {
    const { packageAssignmentId, serviceId } = req.params;
    const userId = req.user.id;

    // Check if package assignment exists and belongs to user
    const assignment = await PackageAssignment.findOne({ assignmentId: packageAssignmentId });
    if (!assignment || assignment.userId.toString() !== userId.toString()) {
      return res.status(200).json({
        success: true,
        canReview: false,
        reason: 'Package assignment not found or unauthorized'
      });
    }

    // Check if service is completed
    const completedService = assignment.completedServices.find(
      cs => cs.serviceId === serviceId
    );

    if (!completedService) {
      return res.status(200).json({
        success: true,
        canReview: false,
        reason: 'Service not completed yet'
      });
    }

    // Check if already reviewed
    const existingReview = await PackageServiceReview.findOne({
      userId,
      packageAssignmentId,
      serviceId
    });

    if (existingReview) {
      return res.status(200).json({
        success: true,
        canReview: false,
        reason: 'Already reviewed',
        review: existingReview
      });
    }

    res.status(200).json({
      success: true,
      canReview: true
    });
  } catch (error) {
    console.error('❌ Can review service error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to check review eligibility'
    });
  }
};

// ADMIN ROUTES

// @desc    Get all service reviews (for admin)
// @route   GET /api/admin/package-service-reviews
// @access  Private (Admin)
exports.getAllServiceReviews = async (req, res) => {
  try {
    const { isApproved, serviceId } = req.query;

    const filter = {};
    if (isApproved !== undefined) filter.isApproved = isApproved === 'true';
    if (serviceId) filter.serviceId = serviceId;

    const reviews = await PackageServiceReview.find(filter)
      .populate('userId', 'fullName name email profilePicture patientId')
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      count: reviews.length,
      data: reviews
    });
  } catch (error) {
    console.error('❌ Get all service reviews error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch reviews'
    });
  }
};

// @desc    Approve/Reject a service review
// @route   PUT /api/admin/package-service-reviews/:id/approve
// @access  Private (Admin)
exports.approveServiceReview = async (req, res) => {
  try {
    const { id } = req.params;
    const { isApproved } = req.body;

    const review = await PackageServiceReview.findById(id);
    if (!review) {
      return res.status(404).json({
        success: false,
        message: 'Review not found'
      });
    }

    review.isApproved = isApproved;
    await review.save();

    console.log(`✅ Package service review ${isApproved ? 'approved' : 'rejected'}: ${id}`);

    res.status(200).json({
      success: true,
      message: `Review ${isApproved ? 'approved' : 'rejected'} successfully`,
      data: review
    });
  } catch (error) {
    console.error('❌ Approve service review error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to approve review'
    });
  }
};

module.exports = exports;
