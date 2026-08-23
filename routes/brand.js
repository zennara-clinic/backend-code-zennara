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
const { protectAdmin, requireRole } = require('../middleware/auth');
const MANAGE = requireRole('super_admin', 'admin');

// Mounted under /api/admin — staff only. /statistics must precede /:id.
router.use(protectAdmin);
router.get('/statistics', getBrandStatistics);
router.get('/', getAllBrands);
router.get('/:id', getBrandById);
router.post('/', MANAGE, createBrand);
router.put('/:id', MANAGE, updateBrand);
router.delete('/:id', MANAGE, deleteBrand);

module.exports = router;
