const mongoose = require('mongoose');
const Review = require('../models/Review');
const Product = require('../models/Product');
const ProductOrder = require('../models/ProductOrder');
const ConsultationReview = require('../models/ConsultationReview');
const TreatmentRating = require('../models/TreatmentRating');
const Booking = require('../models/Booking');
const Consultation = require('../models/Consultation');

// @desc    Submit a product review
// @route   POST /api/reviews
// @access  Private
exports.submitReview = async (req, res) => {
  try {
    const { productId, orderId, rating, reviewText, images } = req.body;
    const userId = req.user._id;

    // Validate required fields
    if (!productId || !orderId || !rating || !reviewText) {
      return res.status(400).json({
        success: false,
        message: 'Please provide all required fields'
      });
    }

    // Check if order exists and belongs to user
    const order = await ProductOrder.findOne({ _id: orderId, userId });
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    // Check if order is delivered
    if (order.orderStatus !== 'Delivered') {
      return res.status(400).json({
        success: false,
        message: 'You can only review products after delivery is completed'
      });
    }

    // Check if product is in the order
    const productInOrder = order.items.find(item => item.productId.toString() === productId);
    if (!productInOrder) {
      return res.status(400).json({
        success: false,
        message: 'This product is not in the specified order'
      });
    }

    // Check if user already reviewed this product for this order
    const existingReview = await Review.findOne({ userId, productId, orderId });
    if (existingReview) {
      return res.status(400).json({
        success: false,
        message: 'You have already reviewed this product for this order'
      });
    }

    // Create review
    const review = await Review.create({
      userId,
      productId,
      orderId,
      rating,
      reviewText,
      images: images || [],
      isVerifiedPurchase: true
    });

    // Update product rating and review count
    await updateProductRating(productId);

    // Populate user info
    await review.populate('userId', 'fullName profilePicture');

    res.status(201).json({
      success: true,
      message: 'Review submitted successfully',
      data: review
    });
  } catch (error) {
    console.error('Submit review error:', error);
    
    // Handle duplicate review error
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'You have already reviewed this product for this order'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to submit review',
      error: error.message
    });
  }
};

// @desc    Get reviews for a product
// @route   GET /api/reviews/product/:productId
// @access  Public
exports.getProductReviews = async (req, res) => {
  try {
    const { productId } = req.params;
    const { page = 1, limit = 10, sort = '-createdAt', rating } = req.query;

    // Validate productId
    if (!mongoose.Types.ObjectId.isValid(productId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid product ID'
      });
    }

    // Build query
    const query = { productId, isApproved: true };
    if (rating) {
      query.rating = parseInt(rating);
    }

    // Parse sort option
    let sortOption = {};
    if (sort === 'helpful') {
      sortOption = { helpfulCount: -1, createdAt: -1 };
    } else if (sort === 'rating-high') {
      sortOption = { rating: -1, createdAt: -1 };
    } else if (sort === 'rating-low') {
      sortOption = { rating: 1, createdAt: -1 };
    } else {
      sortOption = { createdAt: -1 };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [reviews, total] = await Promise.all([
      Review.find(query)
        .sort(sortOption)
        .limit(parseInt(limit))
        .skip(skip)
        .populate('userId', 'fullName profilePicture')
        .lean(),
      Review.countDocuments(query)
    ]);

    // Get rating distribution - with error handling
    let ratingDistribution = [];
    try {
      ratingDistribution = await Review.aggregate([
        { $match: { productId: new mongoose.Types.ObjectId(productId), isApproved: true } },
        { $group: { _id: '$rating', count: { $sum: 1 } } },
        { $sort: { _id: -1 } }
      ]);
    } catch (aggError) {
      console.error('Rating distribution aggregation error:', aggError);
      // Continue without rating distribution
    }

    res.json({
      success: true,
      data: {
        reviews,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / parseInt(limit))
        },
        ratingDistribution
      }
    });
  } catch (error) {
    console.error('Get product reviews error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch reviews',
      error: error.message
    });
  }
};

// @desc    Get user's reviews
// @route   GET /api/reviews/my-reviews
// @access  Private
exports.getMyReviews = async (req, res) => {
  try {
    const userId = req.user._id;
    const { page = 1, limit = 10 } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [reviews, total] = await Promise.all([
      Review.find({ userId })
        .sort({ createdAt: -1 })
        .limit(parseInt(limit))
        .skip(skip)
        .populate('productId', 'name image price')
        .lean(),
      Review.countDocuments({ userId })
    ]);

    res.json({
      success: true,
      data: {
        reviews,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / parseInt(limit))
        }
      }
    });
  } catch (error) {
    console.error('Get my reviews error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch your reviews',
      error: error.message
    });
  }
};

// @desc    Update a review
// @route   PUT /api/reviews/:id
// @access  Private
exports.updateReview = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;
    const { rating, reviewText, images } = req.body;

    const review = await Review.findOne({ _id: id, userId });
    if (!review) {
      return res.status(404).json({
        success: false,
        message: 'Review not found or you do not have permission to update it'
      });
    }

    // Update fields
    if (rating !== undefined) review.rating = rating;
    if (reviewText !== undefined) review.reviewText = reviewText;
    if (images !== undefined) review.images = images;

    await review.save();

    // Update product rating
    await updateProductRating(review.productId);

    await review.populate('userId', 'fullName profilePicture');

    res.json({
      success: true,
      message: 'Review updated successfully',
      data: review
    });
  } catch (error) {
    console.error('Update review error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update review',
      error: error.message
    });
  }
};

// @desc    Delete a review
// @route   DELETE /api/reviews/:id
// @access  Private
exports.deleteReview = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;

    const review = await Review.findOneAndDelete({ _id: id, userId });
    if (!review) {
      return res.status(404).json({
        success: false,
        message: 'Review not found or you do not have permission to delete it'
      });
    }

    // Update product rating
    await updateProductRating(review.productId);

    res.json({
      success: true,
      message: 'Review deleted successfully'
    });
  } catch (error) {
    console.error('Delete review error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete review',
      error: error.message
    });
  }
};

// @desc    Mark review as helpful
// @route   POST /api/reviews/:id/helpful
// @access  Private
exports.markReviewHelpful = async (req, res) => {
  try {
    const { id } = req.params;

    const review = await Review.findByIdAndUpdate(
      id,
      { $inc: { helpfulCount: 1 } },
      { new: true }
    );

    if (!review) {
      return res.status(404).json({
        success: false,
        message: 'Review not found'
      });
    }

    res.json({
      success: true,
      message: 'Review marked as helpful',
      data: { helpfulCount: review.helpfulCount }
    });
  } catch (error) {
    console.error('Mark review helpful error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to mark review as helpful',
      error: error.message
    });
  }
};

// @desc    Check if user can review a product
// @route   GET /api/reviews/can-review/:productId/:orderId
// @access  Private
exports.canReviewProduct = async (req, res) => {
  try {
    const { productId, orderId } = req.params;
    const userId = req.user._id;

    // Check if order exists and belongs to user
    const order = await ProductOrder.findOne({ _id: orderId, userId });
    if (!order) {
      return res.json({
        success: true,
        data: { canReview: false, reason: 'Order not found' }
      });
    }

    // Check if order is delivered
    if (order.orderStatus !== 'Delivered') {
      return res.json({
        success: true,
        data: { canReview: false, reason: 'Order not delivered yet' }
      });
    }

    // Check if product is in the order
    const productInOrder = order.items.find(item => item.productId.toString() === productId);
    if (!productInOrder) {
      return res.json({
        success: true,
        data: { canReview: false, reason: 'Product not in this order' }
      });
    }

    // Check if user already reviewed this product for this order
    const existingReview = await Review.findOne({ userId, productId, orderId });
    if (existingReview) {
      return res.json({
        success: true,
        data: { canReview: false, reason: 'Already reviewed', review: existingReview }
      });
    }

    res.json({
      success: true,
      data: { canReview: true }
    });
  } catch (error) {
    console.error('Can review product error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check review eligibility',
      error: error.message
    });
  }
};

// Helper function to update product rating
async function updateProductRating(productId) {
  try {
    const reviews = await Review.find({ productId, isApproved: true });
    
    if (reviews.length === 0) {
      await Product.findByIdAndUpdate(productId, {
        rating: 0,
        reviews: 0
      });
      return;
    }

    const totalRating = reviews.reduce((sum, review) => sum + review.rating, 0);
    const averageRating = totalRating / reviews.length;

    await Product.findByIdAndUpdate(productId, {
      rating: Math.round(averageRating * 10) / 10, // Round to 1 decimal
      reviews: reviews.length
    });
  } catch (error) {
    console.error('Update product rating error:', error);
  }
}

// ==================== CONSULTATION REVIEWS ====================

// @desc    Submit a consultation review (rating + text)
// @route   POST /api/reviews/consultation
// @access  Private
exports.submitConsultationReview = async (req, res) => {
  try {
    const { consultationId, bookingId, rating, reviewText } = req.body;
    const userId = req.user._id;

    // Validate required fields
    if (!consultationId || !bookingId || !rating || !reviewText) {
      return res.status(400).json({
        success: false,
        message: 'Please provide all required fields'
      });
    }

    // Check if booking exists and belongs to user
    const booking = await Booking.findOne({ _id: bookingId, userId });
    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    // Check if booking is completed
    if (booking.status !== 'Completed') {
      return res.status(400).json({
        success: false,
        message: 'You can only review consultations after they are completed'
      });
    }

    // Check if consultation matches
    if (booking.consultationId.toString() !== consultationId) {
      return res.status(400).json({
        success: false,
        message: 'Consultation does not match the booking'
      });
    }

    // Check if user already reviewed this consultation booking
    const existingReview = await ConsultationReview.findOne({ userId, consultationId, bookingId });
    if (existingReview) {
      return res.status(400).json({
        success: false,
        message: 'You have already reviewed this consultation'
      });
    }

    // Create review
    const review = await ConsultationReview.create({
      userId,
      consultationId,
      bookingId,
      rating,
      reviewText,
      isVerified: true
    });

    // Update consultation rating
    await updateConsultationRating(consultationId);

    // Populate user info
    await review.populate('userId', 'fullName profilePicture');

    res.status(201).json({
      success: true,
      message: 'Consultation review submitted successfully',
      data: review
    });
  } catch (error) {
    console.error('Submit consultation review error:', error);
    
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'You have already reviewed this consultation'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to submit consultation review',
      error: error.message
    });
  }
};

// @desc    Get reviews for a consultation
// @route   GET /api/reviews/consultation/:consultationId
// @access  Public
exports.getConsultationReviews = async (req, res) => {
  try {
    const { consultationId } = req.params;
    const { page = 1, limit = 10, sort = '-createdAt' } = req.query;

    // Validate consultationId
    if (!mongoose.Types.ObjectId.isValid(consultationId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid consultation ID'
      });
    }

    // Build query
    const query = { consultationId, isApproved: true };

    // Parse sort option
    let sortOption = {};
    if (sort === 'helpful') {
      sortOption = { helpfulCount: -1, createdAt: -1 };
    } else if (sort === 'rating-high') {
      sortOption = { rating: -1, createdAt: -1 };
    } else if (sort === 'rating-low') {
      sortOption = { rating: 1, createdAt: -1 };
    } else {
      sortOption = { createdAt: -1 };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [reviews, total] = await Promise.all([
      ConsultationReview.find(query)
        .sort(sortOption)
        .limit(parseInt(limit))
        .skip(skip)
        .populate('userId', 'fullName profilePicture')
        .lean(),
      ConsultationReview.countDocuments(query)
    ]);

    // Get rating distribution
    let ratingDistribution = [];
    try {
      ratingDistribution = await ConsultationReview.aggregate([
        { $match: { consultationId: new mongoose.Types.ObjectId(consultationId), isApproved: true } },
        { $group: { _id: '$rating', count: { $sum: 1 } } },
        { $sort: { _id: -1 } }
      ]);
    } catch (aggError) {
      console.error('Rating distribution aggregation error:', aggError);
    }

    // Calculate average rating
    let averageRating = 0;
    let totalReviews = 0;
    if (ratingDistribution.length > 0) {
      const sum = ratingDistribution.reduce((acc, item) => acc + (item._id * item.count), 0);
      totalReviews = ratingDistribution.reduce((acc, item) => acc + item.count, 0);
      averageRating = totalReviews > 0 ? Math.round((sum / totalReviews) * 10) / 10 : 0;
    }

    res.json({
      success: true,
      data: {
        reviews,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / parseInt(limit))
        },
        ratingDistribution,
        averageRating,
        totalReviews
      }
    });
  } catch (error) {
    console.error('Get consultation reviews error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch consultation reviews',
      error: error.message
    });
  }
};

// @desc    Check if user can review a consultation
// @route   GET /api/reviews/can-review-consultation/:consultationId/:bookingId
// @access  Private
exports.canReviewConsultation = async (req, res) => {
  try {
    const { consultationId, bookingId } = req.params;
    const userId = req.user._id;

    // Check if booking exists and belongs to user
    const booking = await Booking.findOne({ _id: bookingId, userId });
    if (!booking) {
      return res.json({
        success: true,
        data: { canReview: false, reason: 'Booking not found' }
      });
    }

    // Check if booking is completed
    if (booking.status !== 'Completed') {
      return res.json({
        success: true,
        data: { canReview: false, reason: 'Consultation not completed yet' }
      });
    }

    // Check if consultation matches
    if (booking.consultationId.toString() !== consultationId) {
      return res.json({
        success: true,
        data: { canReview: false, reason: 'Consultation does not match booking' }
      });
    }

    // Check if user already reviewed this consultation
    const existingReview = await ConsultationReview.findOne({ userId, consultationId, bookingId });
    if (existingReview) {
      return res.json({
        success: true,
        data: { canReview: false, reason: 'Already reviewed', review: existingReview }
      });
    }

    res.json({
      success: true,
      data: { canReview: true }
    });
  } catch (error) {
    console.error('Can review consultation error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check review eligibility',
      error: error.message
    });
  }
};

// ==================== TREATMENT RATINGS ====================

// @desc    Submit a treatment rating (rating only, no text)
// @route   POST /api/reviews/treatment-rating
// @access  Private
exports.submitTreatmentRating = async (req, res) => {
  try {
    const { treatmentId, bookingId, rating } = req.body;
    const userId = req.user._id;

    // Validate required fields
    if (!treatmentId || !bookingId || !rating) {
      return res.status(400).json({
        success: false,
        message: 'Please provide all required fields'
      });
    }

    // Check if booking exists and belongs to user
    const booking = await Booking.findOne({ _id: bookingId, userId });
    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    // Check if booking is completed
    if (booking.status !== 'Completed') {
      return res.status(400).json({
        success: false,
        message: 'You can only rate treatments after they are completed'
      });
    }

    // Check if user already rated this treatment booking
    const existingRating = await TreatmentRating.findOne({ userId, treatmentId, bookingId });
    if (existingRating) {
      return res.status(400).json({
        success: false,
        message: 'You have already rated this treatment'
      });
    }

    // Create rating
    const treatmentRating = await TreatmentRating.create({
      userId,
      treatmentId,
      bookingId,
      rating,
      isVerified: true
    });

    res.status(201).json({
      success: true,
      message: 'Treatment rating submitted successfully',
      data: treatmentRating
    });
  } catch (error) {
    console.error('Submit treatment rating error:', error);
    
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'You have already rated this treatment'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to submit treatment rating',
      error: error.message
    });
  }
};

// @desc    Check if user can rate a treatment
// @route   GET /api/reviews/can-rate-treatment/:treatmentId/:bookingId
// @access  Private
exports.canRateTreatment = async (req, res) => {
  try {
    const { treatmentId, bookingId } = req.params;
    const userId = req.user._id;

    // Check if booking exists and belongs to user
    const booking = await Booking.findOne({ _id: bookingId, userId });
    if (!booking) {
      return res.json({
        success: true,
        data: { canRate: false, reason: 'Booking not found' }
      });
    }

    // Check if booking is completed
    if (booking.status !== 'Completed') {
      return res.json({
        success: true,
        data: { canRate: false, reason: 'Treatment not completed yet' }
      });
    }

    // Check if user already rated this treatment
    const existingRating = await TreatmentRating.findOne({ userId, treatmentId, bookingId });
    if (existingRating) {
      return res.json({
        success: true,
        data: { canRate: false, reason: 'Already rated', rating: existingRating }
      });
    }

    res.json({
      success: true,
      data: { canRate: true }
    });
  } catch (error) {
    console.error('Can rate treatment error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check rating eligibility',
      error: error.message
    });
  }
};

// Helper function to update consultation rating
async function updateConsultationRating(consultationId) {
  try {
    const reviews = await ConsultationReview.find({ consultationId, isApproved: true });
    
    if (reviews.length === 0) {
      await Consultation.findByIdAndUpdate(consultationId, {
        rating: 0,
        reviews: 0
      });
      return;
    }

    const totalRating = reviews.reduce((sum, review) => sum + review.rating, 0);
    const averageRating = totalRating / reviews.length;

    await Consultation.findByIdAndUpdate(consultationId, {
      rating: Math.round(averageRating * 10) / 10, // Round to 1 decimal
      reviews: reviews.length
    });
  } catch (error) {
    console.error('Update consultation rating error:', error);
  }
}

module.exports = exports;
