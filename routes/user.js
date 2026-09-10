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
// A dermatologist reaches only guests in their own diary (utils/doctorGuestScope).
const { ownGuest, attachMyGuestIds, notForDoctors } = require('../utils/doctorGuestScope');
const OWN = ownGuest((req) => req.params.id);

// All routes require admin authentication
router.use(protectAdmin);

// User management routes
router.post('/', MANAGE, createUser); // Create new user (admin)
router.get('/', VIEW, attachMyGuestIds(), getAllUsers);
router.get('/export', VIEW, notForDoctors, exportUsers);
router.get('/deleted', DELETE, getDeletedAccounts);
router.post('/deleted/:archiveId/restore', DELETE, restoreDeletedAccount);
router.get('/:id', VIEW, OWN, getUserById);
router.put('/:id', MANAGE, OWN, uploadProfilePicture, updateUser); // Add upload middleware
router.delete('/:id', MANAGE, notForDoctors, deleteUser);
router.patch('/:id/statistics', MANAGE, notForDoctors, updateUserStatistics);

// Membership management routes
router.post('/:id/membership', MANAGE, notForDoctors, assignMembership);
router.post('/:id/membership/paid', MANAGE, notForDoctors, require('../controllers/userController').markMembershipPaid); // Assign/extend membership
router.delete('/:id/membership', MANAGE, notForDoctors, cancelMembership); // Cancel membership

// User status management
router.patch('/:id/status', MANAGE, notForDoctors, toggleUserStatus); // Activate/Deactivate user

module.exports = router;
