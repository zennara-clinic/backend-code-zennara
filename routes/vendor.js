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
const { protectAdmin, requireRole, requirePermission, auditLog } = require('../middleware/auth'); // Fixed import path

// All routes require admin authentication
router.use(protectAdmin);

// Statistics route
router.get('/stats', getVendorStats);
router.get('/:id/bank-details', requirePermission('vendors.bank'), auditLog('VENDOR_UPDATED', 'VENDOR'), require('../controllers/vendorController').getVendorBankDetails);

// CRUD routes
const MANAGE = requirePermission('vendors.manage');

router.route('/')
  .get(getVendors)
  .post(MANAGE, createVendor);

router.route('/:id')
  .get(getVendor)
  .put(MANAGE, updateVendor)
  .delete(MANAGE, deleteVendor);

module.exports = router;
