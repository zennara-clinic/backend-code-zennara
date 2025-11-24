const express = require('express');
const router = express.Router();
const {
  getAllReviews,
  respondToReview
} = require('../controllers/packageServiceReviewController');

const { protect, authorize } = require('../middleware/auth');

// Admin routes
router.get('/', protect, authorize('admin'), getAllReviews);
router.put('/:reviewId/respond', protect, authorize('admin'), respondToReview);

module.exports = router;
