const express = require('express');
const router = express.Router();
const {
  getAllServiceReviews,
  approveServiceReview
} = require('../../controllers/packageServiceReviewController');
const { protectAdmin } = require('../../middleware/auth');

// Admin authentication middleware
router.use(protectAdmin);

// Admin routes
router.get('/', getAllServiceReviews);
router.put('/:id/approve', approveServiceReview);

module.exports = router;
