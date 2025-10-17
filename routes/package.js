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
const { protectAdmin } = require('../middleware/auth');

// Public routes
router.get('/', getAllPackages);
router.get('/stats', getPackageStats);
router.get('/:id', getPackage);

// Admin protected routes
router.post('/', protectAdmin, createPackage);
router.put('/:id', protectAdmin, updatePackage);
router.delete('/:id', protectAdmin, deletePackage);
router.patch('/:id/toggle-status', protectAdmin, togglePackageStatus);

module.exports = router;
