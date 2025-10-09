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
  deleteProfilePicture
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
router.post('/profile-picture', protect, upload.single('profilePicture'), uploadProfilePicture);
router.delete('/profile-picture', protect, deleteProfilePicture);

module.exports = router;
