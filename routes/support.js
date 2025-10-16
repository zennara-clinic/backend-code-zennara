const express = require('express');
const router = express.Router();
const {
  createSupportMessage,
  getUserSupportMessages,
  getSupportMessage,
} = require('../controllers/supportController');
const { protect } = require('../middleware/auth');

// Public/Private route - works for both logged in and guest users
// If token is present, it will be associated with user, otherwise treated as guest
router.post('/', (req, res, next) => {
  // Try to authenticate if token is present, but don't fail if not
  const token = req.headers.authorization?.split(' ')[1];
  if (token) {
    return protect(req, res, next);
  }
  next();
}, createSupportMessage);

// User routes (protected)
router.get('/my-messages', protect, getUserSupportMessages);
router.get('/:id', protect, getSupportMessage);

// TODO: Admin routes will be added when admin authentication is implemented
// router.get('/admin/all', protect, adminProtect, getAllSupportMessages);
// router.put('/admin/:id/status', protect, adminProtect, updateSupportMessageStatus);

module.exports = router;
