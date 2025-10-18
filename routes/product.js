const express = require('express');
const router = express.Router();
const {
  getAllProducts,
  getProductById,
  getProductsByFormulation,
  searchProducts,
  getFormulations,
  checkStock
} = require('../controllers/productController');

// Public routes
router.get('/', getAllProducts);
router.get('/formulations/list', getFormulations);
router.get('/formulation/:formulation', getProductsByFormulation);
router.get('/search/:query', searchProducts);
router.post('/check-stock', checkStock);
router.get('/:id', getProductById);

module.exports = router;
