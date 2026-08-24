const express = require('express');
const router = express.Router();
const {
  getAllUsers,
  getUserById,
  updateUser,
  deleteUser,
  updateUserStatistics,
  exportUsers,
  createUser,
  assignMembership,
  cancelMembership,
  toggleUserStatus,
  getDeletedAccounts,
  restoreDeletedAccount,
} = require('../controllers/userController');
const { protectAdmin, requireRole } = require('../middleware/auth');
const MANAGE = requireRole('super_admin');
const { uploadProfilePicture } = require('../middleware/upload');

// All routes require admin authentication
router.use(protectAdmin);

// User management routes
router.post('/', MANAGE, createUser); // Create new user (admin)
router.get('/', getAllUsers);
router.get('/export', MANAGE, exportUsers);
router.get('/deleted', MANAGE, getDeletedAccounts);
router.post('/deleted/:archiveId/restore', MANAGE, restoreDeletedAccount);
router.get('/:id', getUserById);
router.put('/:id', uploadProfilePicture, updateUser); // Add upload middleware
router.delete('/:id', MANAGE, deleteUser);
router.patch('/:id/statistics', updateUserStatistics);

// Membership management routes
router.post('/:id/membership', MANAGE, assignMembership);
router.post('/:id/membership/paid', MANAGE, require('../controllers/userController').markMembershipPaid); // Assign/extend membership
router.delete('/:id/membership', MANAGE, cancelMembership); // Cancel membership

// User status management
router.patch('/:id/status', MANAGE, toggleUserStatus); // Activate/Deactivate user

module.exports = router;
