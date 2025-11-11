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
const { protectAdmin, requireRole, auditLog } = require('../middleware/auth');
const { adminSensitiveOperationsLimiter } = require('../middleware/rateLimiter');

// All routes require admin authentication
router.use(protectAdmin);

// Statistics route (must be before :id routes)
router.get('/statistics', getProductStatistics);

// Bulk operations
router.patch('/bulk-update',
  requireRole('super_admin', 'admin'),
  adminSensitiveOperationsLimiter,
  auditLog('BULK_UPDATE', 'PRODUCT'),
  bulkUpdateProducts
);

// CRUD routes
router.route('/')
  .get(getAllProducts)
  .post(
    requireRole('super_admin', 'admin'),
    auditLog('PRODUCT_CREATED', 'PRODUCT'),
    createProduct
  );

router.route('/:id')
  .get(getProductById)
  .put(
    requireRole('super_admin', 'admin'),
    auditLog('PRODUCT_UPDATED', 'PRODUCT'),
    updateProduct
  )
  .delete(
    requireRole('super_admin', 'admin'),
    adminSensitiveOperationsLimiter,
    auditLog('PRODUCT_DELETED', 'PRODUCT'),
    deleteProduct
  );

// Special operations
router.patch('/:id/toggle-status',
  requireRole('super_admin', 'admin'),
  auditLog('PRODUCT_STATUS_CHANGED', 'PRODUCT'),
  toggleProductStatus
);
router.patch('/:id/stock',
  requireRole('super_admin', 'admin'),
  auditLog('STOCK_UPDATED', 'PRODUCT'),
  updateStock
);

module.exports = router;
