const express = require('express');
const router = express.Router();
const {
  createSupportMessage,
  getUserSupportMessages,
  getSupportMessage,
  getAllSupportMessages,
  updateSupportMessageStatus,
} = require('../controllers/supportController');
const { protect, protectAdmin, auditLog, requireRole } = require('../middleware/auth');
const MANAGE = requireRole('super_admin');

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

// Admin routes — declared before /:id so "admin" is never read as a message id.
router.get('/admin/all', protectAdmin, MANAGE, getAllSupportMessages);
router.patch(
  '/admin/:id/status',
  protectAdmin,
  MANAGE,
  auditLog('SUPPORT_UPDATED', 'SUPPORT'),
  updateSupportMessageStatus,
);
// Kept for older callers that used PUT.
router.put('/admin/:id/status', protectAdmin, MANAGE, updateSupportMessageStatus);

// User routes (protected)
router.get('/my-messages', protect, getUserSupportMessages);
router.get('/:id', protect, getSupportMessage);

module.exports = router;
