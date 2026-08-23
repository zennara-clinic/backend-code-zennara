const express = require('express');
const router = express.Router();
const Review = require('../../models/Review');
const Product = require('../../models/Product');
const { protectAdmin } = require('../../middleware/auth');

/** Recompute a product's rating/count from its approved reviews. */
async function syncProductRating(productId) {
  if (!productId) return;
  const reviews = await Review.find({ productId, isApproved: true }).select('rating').lean();
  const count = reviews.length;
  const avg = count ? reviews.reduce((sum, r) => sum + (r.rating || 0), 0) / count : 0;
  await Product.findByIdAndUpdate(productId, { rating: Math.round(avg * 10) / 10, reviews: count });
}

// Admin authentication middleware
router.use(protectAdmin);

// @desc    Get all product reviews
// @route   GET /api/admin/product-reviews
// @access  Private/Admin
router.get('/', async (req, res) => {
  try {
    const { isApproved, limit, page = 1, search } = req.query;
    const q = {};
    if (isApproved === 'true') q.isApproved = true;
    if (isApproved === 'false') q.isApproved = false;
    if (search) q.comment = { $regex: String(search).trim(), $options: 'i' };
    const perPage = Math.min(500, parseInt(limit, 10) || 200);
    const pageNo = Math.max(1, parseInt(page, 10) || 1);
    const [reviews, total] = await Promise.all([
      Review.find(q)
        .populate('userId', 'fullName email phone profilePicture')
        .populate('productId', 'name image price')
        .sort({ createdAt: -1 })
        .skip((pageNo - 1) * perPage)
        .limit(perPage),
      Review.countDocuments(q),
    ]);

    res.json({
      success: true,
      total,
      pagination: { currentPage: pageNo, totalPages: Math.ceil(total / perPage), total },
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

    // Approval changes what counts towards the product's rating.
    await syncProductRating(review.productId?._id || review.productId);

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

    await syncProductRating(review.productId);

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
