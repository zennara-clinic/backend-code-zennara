const express = require('express');
const router = express.Router();
const {
  submitReview,
  getProductReviews,
  getMyReviews,
  updateReview,
  deleteReview,
  markReviewHelpful,
  canReviewProduct,
  submitConsultationReview,
  getConsultationReviews,
  canReviewConsultation,
  submitTreatmentRating,
  canRateTreatment
} = require('../controllers/reviewController');
const { protect } = require('../middleware/auth');

// ============ PRODUCT REVIEWS ============
// Public routes
router.get('/product/:productId', getProductReviews);

// Protected routes
router.post('/', protect, submitReview);
router.get('/my-reviews', protect, getMyReviews);
router.put('/:id', protect, updateReview);
router.delete('/:id', protect, deleteReview);
router.post('/:id/helpful', protect, markReviewHelpful);
router.get('/can-review/:productId/:orderId', protect, canReviewProduct);

// ============ CONSULTATION REVIEWS ============
// Public routes
router.get('/consultation/:consultationId', getConsultationReviews);

// Protected routes
router.post('/consultation', protect, submitConsultationReview);
router.get('/can-review-consultation/:consultationId/:bookingId', protect, canReviewConsultation);

// ============ TREATMENT RATINGS ============
// Protected routes (no public route as treatments only have ratings, no reviews to display)
router.post('/treatment-rating', protect, submitTreatmentRating);
router.get('/can-rate-treatment/:treatmentId/:bookingId', protect, canRateTreatment);

module.exports = router;
