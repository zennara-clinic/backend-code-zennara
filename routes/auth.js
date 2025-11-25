const express = require('express');
const router = express.Router();
const {
  signup,
  login,
  verifyOTP,
  resendOTP,
  logout,
  logoutAll,
  getMe,
  updateProfile,
  uploadProfilePicture,
  deleteProfilePicture,
  getActiveSessions,
  revokeSession,
  getSecurityLog,
  getSecurityStatus,
  upgradeMembership,
  getUserStats,
  deleteAccount,
  exportUserData
} = require('../controllers/authController');
const {
  updateBankDetails,
  getMyBankDetails
} = require('../controllers/refundController');
const { protect } = require('../middleware/auth');
const { upload } = require('../middleware/upload');
const { generateCSRFToken } = require('../middleware/securityMiddleware');
const logger = require('../utils/logger');
const {
  validateSignup,
  validateLogin,
  validateVerifyOTP,
  validateUpdateProfile
} = require('../middleware/validators');

// CSRF Token endpoint
router.get('/csrf-token', protect, (req, res) => {
  const token = generateCSRFToken(req.user._id.toString());
  res.json({ csrfToken: token });
});

// Public routes with validation
router.post('/signup', validateSignup, signup);
router.post('/login', validateLogin, login); 
router.post('/verify-otp', validateVerifyOTP, verifyOTP);
router.post('/resend-otp', validateLogin, resendOTP);

// Protected routes
router.post('/logout', protect, logout);
router.post('/logout-all', protect, logoutAll);
router.get('/me', protect, getMe);
router.get('/stats', protect, getUserStats);
router.put('/profile', protect, validateUpdateProfile, updateProfile);
router.post('/upgrade-membership', protect, upgradeMembership);

// Profile picture upload with error handling
router.post('/profile-picture', protect, (req, res, next) => {
  const uploadMiddleware = upload.single('profilePicture');
  
  uploadMiddleware(req, res, (err) => {
    if (err) {
      logger.error('Multer upload error', { error: err.message });
      
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          success: false,
          message: 'File too large. Maximum size is 5MB.'
        });
      }
      
      if (err.message && err.message.includes('Invalid file type')) {
        return res.status(400).json({
          success: false,
          message: err.message
        });
      }
      
      return res.status(500).json({
        success: false,
        message: 'File upload failed. Please try again.',
        error: err.message
      });
    }
    
    next();
  });
}, uploadProfilePicture);

router.delete('/profile-picture', protect, deleteProfilePicture);

// Session management routes
router.get('/sessions', protect, getActiveSessions);
router.delete('/sessions/:tokenId', protect, revokeSession);

// Security routes
router.get('/security-log', protect, getSecurityLog);
router.get('/security-status', protect, getSecurityStatus);

// Data privacy routes (DPDPA 2023 compliance)
router.get('/export-data', protect, exportUserData);
router.delete('/account', protect, deleteAccount);

// Bank details routes (for refunds)
router.get('/me/bank-details', protect, getMyBankDetails);
router.put('/me/bank-details', protect, updateBankDetails);

module.exports = router;
