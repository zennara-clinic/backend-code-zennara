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
  toggleUserStatus
} = require('../controllers/userController');
const { protectAdmin } = require('../middleware/auth');

// All routes require admin authentication
router.use(protectAdmin);

// User management routes
router.post('/', createUser); // Create new user (admin)
router.get('/', getAllUsers);
router.get('/export', exportUsers);
router.get('/:id', getUserById);
router.put('/:id', updateUser);
router.delete('/:id', deleteUser);
router.patch('/:id/statistics', updateUserStatistics);

// Membership management routes
router.post('/:id/membership', assignMembership); // Assign/extend membership
router.delete('/:id/membership', cancelMembership); // Cancel membership

// User status management
router.patch('/:id/status', toggleUserStatus); // Activate/Deactivate user

module.exports = router;
