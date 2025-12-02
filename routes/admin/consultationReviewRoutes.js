const express = require('express');
const router = express.Router();
const ConsultationReview = require('../../models/ConsultationReview');
const Consultation = require('../../models/Consultation');
const { protectAdmin } = require('../../middleware/auth');

// Admin authentication middleware
router.use(protectAdmin);

// @desc    Get all consultation reviews
// @route   GET /api/admin/consultation-reviews
// @access  Private/Admin
router.get('/', async (req, res) => {
  try {
    const reviews = await ConsultationReview.find()
      .populate('userId', 'fullName email phone profilePicture')
      .populate('consultationId', 'name title description')
      .populate('bookingId', 'date time')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      data: reviews
    });
  } catch (error) {
    console.error('Get all consultation reviews error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch consultation reviews',
      error: error.message
    });
  }
});

// @desc    Update consultation review approval status
// @route   PUT /api/admin/consultation-reviews/:id/approval
// @access  Private/Admin
router.put('/:id/approval', async (req, res) => {
  try {
    const { isApproved } = req.body;
    const review = await ConsultationReview.findByIdAndUpdate(
      req.params.id,
      { isApproved },
      { new: true }
    ).populate('userId', 'fullName email phone profilePicture')
     .populate('consultationId', 'name title description');

    if (!review) {
      return res.status(404).json({
        success: false,
        message: 'Review not found'
      });
    }

    res.json({
      success: true,
      message: `Review ${isApproved ? 'approved' : 'unapproved'} successfully`,
      data: review
    });
  } catch (error) {
    console.error('Update consultation review approval error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update review approval',
      error: error.message
    });
  }
});

// @desc    Delete a consultation review
// @route   DELETE /api/admin/consultation-reviews/:id
// @access  Private/Admin
router.delete('/:id', async (req, res) => {
  try {
    const review = await ConsultationReview.findByIdAndDelete(req.params.id);

    if (!review) {
      return res.status(404).json({
        success: false,
        message: 'Review not found'
      });
    }

    // Update consultation rating after deletion
    const reviews = await ConsultationReview.find({ 
      consultationId: review.consultationId, 
      isApproved: true 
    });
    
    if (reviews.length === 0) {
      await Consultation.findByIdAndUpdate(review.consultationId, {
        rating: 0,
        reviews: 0
      });
    } else {
      const totalRating = reviews.reduce((sum, r) => sum + r.rating, 0);
      const averageRating = totalRating / reviews.length;
      
      await Consultation.findByIdAndUpdate(review.consultationId, {
        rating: Math.round(averageRating * 10) / 10,
        reviews: reviews.length
      });
    }

    res.json({
      success: true,
      message: 'Review deleted successfully'
    });
  } catch (error) {
    console.error('Delete consultation review error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete review',
      error: error.message
    });
  }
});

module.exports = router;
