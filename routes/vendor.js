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
const { protectAdmin } = require('../middleware/auth');

// All routes require admin authentication
router.use(protectAdmin);

// Statistics route
router.get('/stats', getVendorStats);

// CRUD routes
router.route('/')
  .get(getVendors)
  .post(createVendor);

router.route('/:id')
  .get(getVendor)
  .put(updateVendor)
  .delete(deleteVendor);

module.exports = router;
