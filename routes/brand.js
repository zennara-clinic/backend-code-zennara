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

// All routes require admin authentication
router.use(protectAdmin);

// Statistics route (must be before /:id)
router.get('/statistics', getBrandStatistics);

// CRUD routes
router.route('/')
  .get(getAllBrands)
  .post(createBrand);

router.route('/:id')
  .get(getBrandById)
  .put(updateBrand)
  .delete(deleteBrand);

module.exports = router;
