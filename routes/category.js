const express = require('express');
const router = express.Router();
const {
  getAllCategories,
  getCategoryById,
  createCategory,
  updateCategory,
  toggleCategoryStatus,
  deleteCategory,
  syncCategoryCounts
} = require('../controllers/categoryController');

// Public routes
router.get('/', getAllCategories);
router.get('/:id', getCategoryById);

// Admin routes (add authentication middleware later)
router.post('/', createCategory);
router.put('/:id', updateCategory);
router.patch('/:id/toggle-status', toggleCategoryStatus);
router.delete('/:id', deleteCategory);
router.post('/sync-counts', syncCategoryCounts);

module.exports = router;
