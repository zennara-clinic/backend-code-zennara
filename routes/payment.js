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

// Protected routes - require authentication
router.post('/product/create', protect, createProductOrderPayment);
router.post('/product/verify', protect, verifyProductPayment);
router.post('/membership/create', protect, createMembershipPayment);
router.post('/membership/verify', protect, verifyMembershipPayment);

// Webhook route (public but signature verified)
router.post('/webhook', handleWebhook);

module.exports = router;
