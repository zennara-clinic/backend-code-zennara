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
  getSecurityStatus
} = require('../controllers/authController');
const { protect } = require('../middleware/auth');
const { upload } = require('../middleware/upload');

// Public routes
router.post('/signup', signup);
router.post('/login', login); 
router.post('/verify-otp', verifyOTP);
router.post('/resend-otp', resendOTP);

// Protected routes
router.post('/logout', protect, logout);
router.post('/logout-all', protect, logoutAll);
router.get('/me', protect, getMe);
router.put('/profile', protect, updateProfile);

// Profile picture upload with error handling
router.post('/profile-picture', protect, (req, res, next) => {
  const uploadMiddleware = upload.single('profilePicture');
  
  uploadMiddleware(req, res, (err) => {
    if (err) {
      console.error('❌ Multer upload error:', err);
      
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

module.exports = router;
