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
const { protectAdmin, auditLog } = require('../middleware/auth');

// Public routes — the mobile app browses categories.
router.get('/', getAllCategories);
router.get('/:id', getCategoryById);

// Admin routes. These used to be open: anyone who knew the path could create,
// rename or delete a service category.
router.post('/', protectAdmin, auditLog('CATALOGUE_CREATED', 'CATALOGUE'), createCategory);
router.put('/:id', protectAdmin, auditLog('CATALOGUE_UPDATED', 'CATALOGUE'), updateCategory);
router.patch(
  '/:id/toggle-status',
  protectAdmin,
  auditLog('CATALOGUE_STATUS_CHANGED', 'CATALOGUE'),
  toggleCategoryStatus,
);
router.delete('/:id', protectAdmin, auditLog('CATALOGUE_DELETED', 'CATALOGUE'), deleteCategory);
router.post('/sync-counts', protectAdmin, syncCategoryCounts);

module.exports = router;
