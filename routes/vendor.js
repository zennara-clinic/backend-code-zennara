const express = require('express');
const router = express.Router();
const {
  getVendors,
  getVendor,
  createVendor,
  updateVendor,
  deleteVendor,
  getVendorStats
} = require('../controllers/vendorController');
const { protectAdmin, requireRole, auditLog } = require('../middleware/auth'); // Fixed import path

// All routes require admin authentication
router.use(protectAdmin);

// Statistics route
router.get('/stats', getVendorStats);
router.get('/:id/bank-details', requireRole('super_admin', 'admin'), auditLog('VENDOR_UPDATED', 'VENDOR'), require('../controllers/vendorController').getVendorBankDetails);

// CRUD routes
const MANAGE = requireRole('super_admin', 'admin');

router.route('/')
  .get(getVendors)
  .post(MANAGE, createVendor);

router.route('/:id')
  .get(getVendor)
  .put(MANAGE, updateVendor)
  .delete(MANAGE, deleteVendor);

module.exports = router;
