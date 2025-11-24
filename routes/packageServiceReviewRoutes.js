const express = require('express');
const router = express.Router();
const {
  createOrUpdateReview,
  getMyReviews,
  getServiceReviews,
  getServiceReview,
  deleteReview
} = require('../controllers/packageServiceReviewController');

const { protect } = require('../middleware/auth');

// User routes
router.post('/', protect, createOrUpdateReview);
router.get('/my-reviews', protect, getMyReviews);
router.get('/service/:serviceId', getServiceReviews);
router.get('/:assignmentId/:serviceId', protect, getServiceReview);
router.delete('/:reviewId', protect, deleteReview);

module.exports = router;
