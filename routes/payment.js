const express = require('express');
const router = express.Router();
const {
  createProductOrderPayment,
  verifyProductPayment,
  createMembershipPayment,
  verifyMembershipPayment,
  handleWebhook
} = require('../controllers/paymentController');
const { protect } = require('../middleware/auth');
const { paymentLimiter } = require('../middleware/rateLimiter');

// Protected routes - require authentication
router.use(protect);

// Product order payment routes with rate limiting
router.post('/product/create', paymentLimiter, createProductOrderPayment);
router.post('/product/verify', paymentLimiter, verifyProductPayment);

// Membership payment routes with rate limiting
router.post('/membership/create', paymentLimiter, createMembershipPayment);
router.post('/membership/verify', paymentLimiter, verifyMembershipPayment);

// Webhook route (public but signature verified)
router.post('/webhook', handleWebhook);

module.exports = router;
