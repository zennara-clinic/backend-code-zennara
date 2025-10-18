const express = require('express');
const router = express.Router();
const {
  getAllProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
  toggleProductStatus,
  updateStock,
  bulkUpdateProducts,
  getProductStatistics
} = require('../controllers/adminProductController');
const { protectAdmin } = require('../middleware/auth');

// All routes require admin authentication
router.use(protectAdmin);

// Statistics route (must be before :id routes)
router.get('/statistics', getProductStatistics);

// Bulk operations
router.patch('/bulk-update', bulkUpdateProducts);

// CRUD routes
router.route('/')
  .get(getAllProducts)
  .post(createProduct);

router.route('/:id')
  .get(getProductById)
  .put(updateProduct)
  .delete(deleteProduct);

// Special operations
router.patch('/:id/toggle-status', toggleProductStatus);
router.patch('/:id/stock', updateStock);

module.exports = router;
