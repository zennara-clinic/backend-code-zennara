const express = require('express');
const router = express.Router();
const {
  adminLogin,
  adminVerifyOTP,
  adminResendOTP,
  adminLogout,
  getAdminProfile,
  checkAuthorizedEmail
} = require('../controllers/adminAuthController');
const { protect } = require('../middleware/auth');

// Public routes
router.post('/login', adminLogin);
router.post('/verify-otp', adminVerifyOTP);
router.post('/resend-otp', adminResendOTP);
router.post('/check-email', checkAuthorizedEmail);

// Protected routes (require admin authentication)
router.post('/logout', protect, adminLogout);
router.get('/me', protect, getAdminProfile);

module.exports = router;
