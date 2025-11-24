const express = require('express');
const router = express.Router();
const {
  getAllReviews,
  respondToReview
} = require('../../controllers/packageServiceReviewController');

const { protectAdmin } = require('../../middleware/auth');

// Admin routes
router.get('/', protectAdmin, getAllReviews);
router.put('/:reviewId/respond', protectAdmin, respondToReview);

module.exports = router;
