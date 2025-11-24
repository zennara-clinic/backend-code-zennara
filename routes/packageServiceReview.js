const express = require('express');
const router = express.Router();
const {
  submitServiceReview,
  updateServiceReview,
  deleteServiceReview,
  getMyServiceReviews,
  getServiceReviews,
  canReviewService
} = require('../controllers/packageServiceReviewController');
const { protect } = require('../middleware/auth');

// User routes
router.post('/', protect, submitServiceReview);
router.put('/:id', protect, updateServiceReview);
router.delete('/:id', protect, deleteServiceReview);
router.get('/my-reviews', protect, getMyServiceReviews);
router.get('/service/:serviceId', getServiceReviews);
router.get('/can-review/:packageAssignmentId/:serviceId', protect, canReviewService);

module.exports = router;
