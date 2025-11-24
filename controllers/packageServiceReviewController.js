const PackageServiceReview = require('../models/PackageServiceReview');
const PackageAssignment = require('../models/PackageAssignment');

// @desc    Create or update a service review
// @route   POST /api/package-service-reviews
// @access  Private (User)
exports.createOrUpdateReview = async (req, res) => {
  try {
    const {
      assignmentId,
      serviceId,
      rating,
      review,
      staffRating,
      wouldRecommend,
      serviceQuality,
      facilityCleanliness,
      waitTime,
      isPublic
    } = req.body;

    // Validate required fields
    if (!assignmentId || !serviceId || !rating || wouldRecommend === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Please provide assignmentId, serviceId, rating, and wouldRecommend'
      });
    }

    // Validate rating range
    if (rating < 1 || rating > 5) {
      return res.status(400).json({
        success: false,
        message: 'Rating must be between 1 and 5'
      });
    }

    // Check if assignment exists and belongs to user
    const assignment = await PackageAssignment.findOne({
      _id: assignmentId,
      userId: req.user.id
    });

    if (!assignment) {
      return res.status(404).json({
        success: false,
        message: 'Assignment not found or access denied'
      });
    }

    // Check if service is completed in this assignment
    const isServiceCompleted = assignment.completedServices?.some(
      cs => cs.serviceId === serviceId
    );

    if (!isServiceCompleted) {
      return res.status(400).json({
        success: false,
        message: 'Service must be completed before reviewing'
      });
    }

    // Get service name from package details
    const service = assignment.packageDetails.services.find(s => s.serviceId === serviceId);
    const serviceName = service?.serviceName || serviceId;

    // Find existing review or create new one
    const existingReview = await PackageServiceReview.findOne({
      assignmentId,
      serviceId,
      userId: req.user.id
    });

    let reviewData;
    if (existingReview) {
      // Update existing review
      reviewData = await PackageServiceReview.findByIdAndUpdate(
        existingReview._id,
        {
          rating,
          review: review || '',
          staffRating: staffRating || {},
          wouldRecommend,
          serviceQuality,
          facilityCleanliness,
          waitTime,
          isPublic: isPublic || false
        },
        { new: true, runValidators: true }
      );
    } else {
      // Create new review
      reviewData = await PackageServiceReview.create({
        assignmentId,
        serviceId,
        serviceName,
        userId: req.user.id,
        rating,
        review: review || '',
        staffRating: staffRating || {},
        wouldRecommend,
        serviceQuality,
        facilityCleanliness,
        waitTime,
        isPublic: isPublic || false
      });
    }

    res.status(200).json({
      success: true,
      message: existingReview ? 'Review updated successfully' : 'Review submitted successfully',
      data: reviewData
    });
  } catch (error) {
    console.error('❌ Create/Update review error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to save review'
    });
  }
};

// @desc    Get user's reviews for completed services
// @route   GET /api/package-service-reviews/my-reviews
// @access  Private (User)
exports.getMyReviews = async (req, res) => {
  try {
    const reviews = await PackageServiceReview.find({ userId: req.user.id })
      .populate('assignmentId', 'assignmentId packageDetails.packageName')
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      count: reviews.length,
      data: reviews
    });
  } catch (error) {
    console.error('❌ Get my reviews error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch reviews'
    });
  }
};

// @desc    Get reviews for a specific service
// @route   GET /api/package-service-reviews/service/:serviceId
// @access  Public
exports.getServiceReviews = async (req, res) => {
  try {
    const { serviceId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    // Only return public reviews
    const reviews = await PackageServiceReview.find({ 
      serviceId, 
      isPublic: true 
    })
      .populate('userId', 'fullName patientId')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await PackageServiceReview.countDocuments({ 
      serviceId, 
      isPublic: true 
    });

    // Calculate average ratings
    const stats = await PackageServiceReview.aggregate([
      { $match: { serviceId, isPublic: true } },
      {
        $group: {
          _id: null,
          avgRating: { $avg: '$rating' },
          avgServiceQuality: { $avg: '$serviceQuality' },
          avgFacilityCleanliness: { $avg: '$facilityCleanliness' },
          avgWaitTime: { $avg: '$waitTime' },
          totalReviews: { $sum: 1 },
          wouldRecommendCount: {
            $sum: { $cond: ['$wouldRecommend', 1, 0] }
          }
        }
      }
    ]);

    const ratingStats = stats[0] || {
      avgRating: 0,
      avgServiceQuality: 0,
      avgFacilityCleanliness: 0,
      avgWaitTime: 0,
      totalReviews: 0,
      wouldRecommendCount: 0
    };

    res.status(200).json({
      success: true,
      data: reviews,
      stats: {
        ...ratingStats,
        recommendationRate: ratingStats.totalReviews > 0 
          ? (ratingStats.wouldRecommendCount / ratingStats.totalReviews) * 100 
          : 0
      },
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('❌ Get service reviews error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch service reviews'
    });
  }
};

// @desc    Get review details for a specific completed service
// @route   GET /api/package-service-reviews/:assignmentId/:serviceId
// @access  Private (User)
exports.getServiceReview = async (req, res) => {
  try {
    const { assignmentId, serviceId } = req.params;

    const review = await PackageServiceReview.findOne({
      assignmentId,
      serviceId,
      userId: req.user.id
    });

    res.status(200).json({
      success: true,
      data: review || null
    });
  } catch (error) {
    console.error('❌ Get service review error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch review'
    });
  }
};

// @desc    Delete a review
// @route   DELETE /api/package-service-reviews/:reviewId
// @access  Private (User)
exports.deleteReview = async (req, res) => {
  try {
    const { reviewId } = req.params;

    const review = await PackageServiceReview.findOne({
      _id: reviewId,
      userId: req.user.id
    });

    if (!review) {
      return res.status(404).json({
        success: false,
        message: 'Review not found or access denied'
      });
    }

    await PackageServiceReview.findByIdAndDelete(reviewId);

    res.status(200).json({
      success: true,
      message: 'Review deleted successfully'
    });
  } catch (error) {
    console.error('❌ Delete review error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete review'
    });
  }
};

// @desc    Admin: Get all reviews (for management)
// @route   GET /api/admin/package-service-reviews
// @access  Private (Admin)
exports.getAllReviews = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    const { serviceId, rating, wouldRecommend } = req.query;

    // Build filter
    const filter = {};
    if (serviceId) filter.serviceId = serviceId;
    if (rating) filter.rating = parseInt(rating);
    if (wouldRecommend !== undefined) filter.wouldRecommend = wouldRecommend === 'true';

    const reviews = await PackageServiceReview.find(filter)
      .populate('userId', 'fullName patientId email')
      .populate('assignmentId', 'assignmentId packageDetails.packageName')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await PackageServiceReview.countDocuments(filter);

    res.status(200).json({
      success: true,
      count: reviews.length,
      data: reviews,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('❌ Get all reviews error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch reviews'
    });
  }
};

// @desc    Admin: Respond to a review
// @route   PUT /api/admin/package-service-reviews/:reviewId/respond
// @access  Private (Admin)
exports.respondToReview = async (req, res) => {
  try {
    const { reviewId } = req.params;
    const { text } = req.body;

    if (!text || text.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Response text is required'
      });
    }

    const review = await PackageServiceReview.findByIdAndUpdate(
      reviewId,
      {
        adminResponse: {
          text: text.trim(),
          respondedAt: new Date(),
          respondedBy: req.admin.id
        }
      },
      { new: true }
    );

    if (!review) {
      return res.status(404).json({
        success: false,
        message: 'Review not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Response added successfully',
      data: review
    });
  } catch (error) {
    console.error('❌ Respond to review error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add response'
    });
  }
};
