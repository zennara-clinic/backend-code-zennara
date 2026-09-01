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
const { protectAdmin, requireRole, requirePermission, auditLog } = require('../middleware/auth');
const { adminSensitiveOperationsLimiter } = require('../middleware/rateLimiter');

// All routes require admin authentication
router.use(protectAdmin);

// Statistics route (must be before :id routes)
router.get('/statistics', getProductStatistics);

// Bulk operations
router.patch('/bulk-update',
  requirePermission('products.manage'),
  adminSensitiveOperationsLimiter,
  auditLog('BULK_UPDATE', 'PRODUCT'),
  bulkUpdateProducts
);

// CRUD routes
router.route('/')
  .get(getAllProducts)
  .post(
    requirePermission('products.manage'),
    auditLog('PRODUCT_CREATED', 'PRODUCT'),
    createProduct
  );

router.route('/:id')
  .get(getProductById)
  .put(
    requirePermission('products.manage'),
    auditLog('PRODUCT_UPDATED', 'PRODUCT'),
    updateProduct
  )
  .delete(
    requirePermission('products.manage'),
    adminSensitiveOperationsLimiter,
    auditLog('PRODUCT_DELETED', 'PRODUCT'),
    deleteProduct
  );

// Special operations
router.patch('/:id/toggle-status',
  requirePermission('products.manage'),
  auditLog('PRODUCT_STATUS_CHANGED', 'PRODUCT'),
  toggleProductStatus
);
router.patch('/:id/stock',
  requirePermission('products.manage'),
  auditLog('STOCK_UPDATED', 'PRODUCT'),
  updateStock
);

module.exports = router;
