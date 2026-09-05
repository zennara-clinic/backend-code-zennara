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
router.post('/check-email', adminLoginLimiter, checkAuthorizedEmail);

// Protected routes (require admin authentication)
router.post('/logout', protectAdmin, adminLogout);
router.get('/me', protectAdmin, getAdminProfile);

// Self-service account settings — any signed-in staff member, their own row only.
const { updateMyContact } = require('../controllers/adminAuthController');
// Name, phone and photo — the account's own row only.
router.put('/me', protectAdmin, require('../controllers/adminAuthController').updateMyProfile);
router.put('/me/contact', protectAdmin, updateMyContact);
// Sign out everywhere: bumps the session version and revokes every stored session.
router.post('/me/logout-all', protectAdmin, require('../controllers/adminAuthController').logoutAll);
// First-login walkthrough state (per account, not per browser).
router.put('/me/tours', protectAdmin, require('../controllers/adminAuthController').markTourSeen);
router.delete('/me/tours', protectAdmin, require('../controllers/adminAuthController').resetTours);

module.exports = router;
