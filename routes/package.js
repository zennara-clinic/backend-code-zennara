const express = require('express');
const router = express.Router();
const {
  createPackage,
  getAllPackages,
  getPackage,
  updatePackage,
  deletePackage,
  togglePackageStatus,
  getPackageStats
} = require('../controllers/packageController');
const { protectAdmin, identifyAdmin, requireRole } = require('../middleware/auth');
const MANAGE = requireRole('super_admin');

// Public routes
router.get('/', identifyAdmin, getAllPackages);
router.get('/stats', getPackageStats);
router.get('/:id', getPackage);

// Admin protected routes
router.post('/', protectAdmin, MANAGE, createPackage);
router.put('/:id', protectAdmin, MANAGE, updatePackage);
router.delete('/:id', protectAdmin, MANAGE, deletePackage);
router.patch('/:id/toggle-status', protectAdmin, MANAGE, togglePackageStatus);

module.exports = router;
