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
router.post('/login-password', adminLoginLimiter, require('../controllers/adminAuthController').adminPasswordLogin);
router.post('/verify-otp', adminOTPLimiter, adminVerifyOTP);
router.post('/resend-otp', adminLoginLimiter, adminResendOTP);
router.post('/check-email', adminLoginLimiter, checkAuthorizedEmail);

// Protected routes (require admin authentication)
router.post('/logout', protectAdmin, adminLogout);
router.get('/me', protectAdmin, getAdminProfile);

// Self-service account settings — any signed-in staff member, their own row only.
const { updateMyContact, updateMyPassword } = require('../controllers/adminAuthController');
router.put('/me/contact', protectAdmin, updateMyContact);
router.put('/me/password', protectAdmin, updateMyPassword);

module.exports = router;
