const express = require('express');
const router = express.Router();
const {
  getAllServiceReviews,
  approveServiceReview
} = require('../../controllers/packageServiceReviewController');
const PackageServiceReview = require('../../models/PackageServiceReview');
const { protectAdmin } = require('../../middleware/auth');

// Admin authentication middleware
router.use(protectAdmin);

// Admin routes
router.get('/', getAllServiceReviews);
router.put('/:id/approval', approveServiceReview);
router.put('/:id/approve', approveServiceReview); // Keep for backward compatibility

// @desc    Delete a package service review
// @route   DELETE /api/admin/package-service-reviews/:id
// @access  Private/Admin
router.delete('/:id', async (req, res) => {
  try {
    const review = await PackageServiceReview.findByIdAndDelete(req.params.id);

    if (!review) {
      return res.status(404).json({
        success: false,
        message: 'Review not found'
      });
    }

    res.json({
      success: true,
      message: 'Review deleted successfully'
    });
  } catch (error) {
    console.error('Delete service review error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete review',
      error: error.message
    });
  }
});

module.exports = router;
