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
const { protectAdmin, requireRole, requirePermission } = require('../middleware/auth');
const MANAGE = requirePermission('patients.manage');
const VIEW = requirePermission('patients.view');
const DELETE = requirePermission('patients.delete');
const { uploadProfilePicture } = require('../middleware/upload');

// All routes require admin authentication
router.use(protectAdmin);

// User management routes
router.post('/', MANAGE, createUser); // Create new user (admin)
router.get('/', VIEW, getAllUsers);
router.get('/export', VIEW, exportUsers);
router.get('/deleted', DELETE, getDeletedAccounts);
router.post('/deleted/:archiveId/restore', DELETE, restoreDeletedAccount);
router.get('/:id', VIEW, getUserById);
router.put('/:id', MANAGE, uploadProfilePicture, updateUser); // Add upload middleware
router.delete('/:id', MANAGE, deleteUser);
router.patch('/:id/statistics', MANAGE, updateUserStatistics);

// Membership management routes
router.post('/:id/membership', MANAGE, assignMembership);
router.post('/:id/membership/paid', MANAGE, require('../controllers/userController').markMembershipPaid); // Assign/extend membership
router.delete('/:id/membership', MANAGE, cancelMembership); // Cancel membership

// User status management
router.patch('/:id/status', MANAGE, toggleUserStatus); // Activate/Deactivate user

module.exports = router;
