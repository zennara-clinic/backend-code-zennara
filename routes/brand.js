const express = require('express');
const router = express.Router();
const {
  getAllBrands,
  getBrandById,
  createBrand,
  updateBrand,
  deleteBrand,
  getBrandStatistics
} = require('../controllers/brandController');
const { protectAdmin, requireRole, requirePermission } = require('../middleware/auth');
const MANAGE = requirePermission('brands.manage');

// Mounted under /api/admin — staff only. /statistics must precede /:id.
router.use(protectAdmin);
router.use(requirePermission('brands.view', 'brands.manage', 'products.view', 'inventory.view'));
router.get('/statistics', getBrandStatistics);
router.get('/', getAllBrands);
router.get('/:id', getBrandById);
router.post('/', MANAGE, createBrand);
router.put('/:id', MANAGE, updateBrand);
router.delete('/:id', MANAGE, deleteBrand);

module.exports = router;
