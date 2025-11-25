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
const { protectAdmin } = require('../middleware/auth');

// Public routes - guests can view brands
router.get('/', getAllBrands);
router.get('/:id', getBrandById);

// Admin protected routes
router.get('/statistics', protectAdmin, getBrandStatistics);
router.post('/', protectAdmin, createBrand);
router.put('/:id', protectAdmin, updateBrand);
router.delete('/:id', protectAdmin, deleteBrand);

module.exports = router;
