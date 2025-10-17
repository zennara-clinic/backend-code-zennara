const express = require('express');
const router = express.Router();
const {
  getAllProducts,
  getProductById,
  getProductsByCategory,
  searchProducts,
  getCategories,
  checkStock
} = require('../controllers/productController');

// Public routes
router.get('/', getAllProducts);
router.get('/categories/list', getCategories);
router.get('/category/:category', getProductsByCategory);
router.get('/search/:query', searchProducts);
router.post('/check-stock', checkStock);
router.get('/:id', getProductById);

module.exports = router;
