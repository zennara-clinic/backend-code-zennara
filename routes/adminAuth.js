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
const { protect, protectAdmin } = require('../middleware/auth');
const { authLimiter, otpLimiter } = require('../middleware/rateLimiter');
const { validateEmail } = require('../middleware/sanitizer');
const { 
  preventAdminBruteForce, 
  detectSuspiciousActivity,
  adminIPWhitelist 
} = require('../middleware/adminSecurity');

// Apply security middleware to all admin auth routes
router.use(detectSuspiciousActivity);

// Optional: Enable IP whitelist by uncommenting below
// router.use(adminIPWhitelist);

// Public routes with strict rate limiting and validation
router.post('/login', 
  authLimiter, 
  preventAdminBruteForce, 
  validateEmail, 
  adminLogin
);

router.post('/verify-otp', 
  authLimiter, 
  adminVerifyOTP
);

router.post('/resend-otp', 
  otpLimiter, 
  adminResendOTP
);

router.post('/check-email', 
  authLimiter, 
  validateEmail, 
  checkAuthorizedEmail
);

// Protected routes (require admin authentication)
router.post('/logout', protectAdmin, adminLogout);
router.get('/me', protectAdmin, getAdminProfile);

module.exports = router;
