const express = require('express');
const router = express.Router();
const {
  getAllServiceReviews,
  approveServiceReview
} = require('../../controllers/packageServiceReviewController');
const { protect, admin } = require('../../middleware/auth');

// Admin routes
router.get('/', protect, admin, getAllServiceReviews);
router.put('/:id/approve', protect, admin, approveServiceReview);

module.exports = router;
