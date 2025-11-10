const express = require('express');
const router = express.Router();
const { adminLoginLimiter, adminOTPLimiter } = require('../middleware/rateLimiter');
const {
  adminLogin,
  adminVerifyOTP,
  adminResendOTP,
  adminLogout,
  getAdminProfile,
  checkAuthorizedEmail
} = require('../controllers/adminAuthController');
const { protectAdmin } = require('../middleware/auth');

// Public routes (with rate limiting)
router.post('/login', adminLoginLimiter, adminLogin);
router.post('/verify-otp', adminOTPLimiter, adminVerifyOTP);
router.post('/resend-otp', adminLoginLimiter, adminResendOTP);
router.post('/check-email', checkAuthorizedEmail);

// Protected routes (require admin authentication)
router.post('/logout', protectAdmin, adminLogout);
router.get('/me', protectAdmin, getAdminProfile);

module.exports = router;
