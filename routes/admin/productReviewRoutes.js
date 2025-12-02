const express = require('express');
const router = express.Router();
const Review = require('../../models/Review');
const { protectAdmin } = require('../../middleware/auth');

// Admin authentication middleware
router.use(protectAdmin);

// @desc    Get all product reviews
// @route   GET /api/admin/product-reviews
// @access  Private/Admin
router.get('/', async (req, res) => {
  try {
    const reviews = await Review.find()
      .populate('userId', 'fullName email phone profilePicture')
      .populate('productId', 'name image price')
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      data: reviews
    });
  } catch (error) {
    console.error('Get all product reviews error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch product reviews',
      error: error.message
    });
  }
});

// @desc    Update review approval status
// @route   PUT /api/admin/product-reviews/:id/approval
// @access  Private/Admin
router.put('/:id/approval', async (req, res) => {
  try {
    const { isApproved } = req.body;
    const review = await Review.findByIdAndUpdate(
      req.params.id,
      { isApproved },
      { new: true }
    ).populate('userId', 'fullName email phone profilePicture')
     .populate('productId', 'name image price');

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
    console.error('Update review approval error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update review approval',
      error: error.message
    });
  }
});

// @desc    Delete a product review
// @route   DELETE /api/admin/product-reviews/:id
// @access  Private/Admin
router.delete('/:id', async (req, res) => {
  try {
    const review = await Review.findByIdAndDelete(req.params.id);

    if (!review) {
      return res.status(404).json({
        success: false,
        message: 'Review not found'
      });
    }

    // Update product rating after deletion
    const Review = require('../../models/Review');
    const Product = require('../../models/Product');
    
    const reviews = await Review.find({ productId: review.productId, isApproved: true });
    
    if (reviews.length === 0) {
      await Product.findByIdAndUpdate(review.productId, {
        rating: 0,
        reviews: 0
      });
    } else {
      const totalRating = reviews.reduce((sum, r) => sum + r.rating, 0);
      const averageRating = totalRating / reviews.length;
      
      await Product.findByIdAndUpdate(review.productId, {
        rating: Math.round(averageRating * 10) / 10,
        reviews: reviews.length
      });
    }

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
});

module.exports = router;
