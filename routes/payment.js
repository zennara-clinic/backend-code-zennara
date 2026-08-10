const express = require('express');
const router = express.Router();
const {
  createProductOrderPayment,
  verifyProductPayment,
  createMembershipPayment,
  verifyMembershipPayment,
  createConsultationPayment,
  verifyConsultationPayment,
  handleWebhook
} = require('../controllers/paymentController');
const { protect } = require('../middleware/auth');
const {
  paymentOrderLimiter,
  paymentVerificationLimiter,
} = require('../middleware/rateLimiter');

// Protected routes - require authentication
router.post('/product/create', protect, paymentOrderLimiter, createProductOrderPayment);
router.post('/product/verify', protect, paymentVerificationLimiter, verifyProductPayment);
router.post('/membership/create', protect, paymentOrderLimiter, createMembershipPayment);
router.post('/membership/verify', protect, paymentVerificationLimiter, verifyMembershipPayment);
router.post('/consultation/create', protect, paymentOrderLimiter, createConsultationPayment);
router.post('/consultation/verify', protect, paymentVerificationLimiter, verifyConsultationPayment);

// Webhook route (public but signature verified)
router.post('/webhook', handleWebhook);

module.exports = router;
