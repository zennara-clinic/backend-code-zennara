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
const multer = require('multer');
const appStockUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const productCtrl = require('../controllers/adminProductController');

// All routes require admin authentication
router.use(protectAdmin);

// Statistics route (must be before :id routes)
// The catalogue is also read where products are only named: coupon scoping,
// inventory lines and the analytics report.
const VIEW = requirePermission('products.view', 'coupons.view', 'coupons.manage', 'inventory.view', 'analytics.view');
const MANAGE = requirePermission('products.manage');
router.get('/statistics', VIEW, getProductStatistics);

// The ledger behind one product's stock figure.
router.get('/:id/stock-movements', VIEW, productCtrl.getStockMovements);

// App Stock template — the Commerce catalogue's import / export sheet. One-way: never writes to Zenoti.
router.get('/app-stock/export', VIEW, productCtrl.appStockExport);
router.post('/app-stock/preview', MANAGE, appStockUpload.single('file'), productCtrl.appStockPreview);
router.post('/app-stock/import', MANAGE, appStockUpload.single('file'), auditLog('BULK_IMPORT', 'PRODUCT'), productCtrl.appStockImport);

// Bulk operations
router.patch('/bulk-update',
  requirePermission('products.manage'),
  adminSensitiveOperationsLimiter,
  auditLog('BULK_UPDATE', 'PRODUCT'),
  bulkUpdateProducts
);

// CRUD routes
router.route('/')
  .get(VIEW, getAllProducts)
  .post(
    requirePermission('products.manage'),
    auditLog('PRODUCT_CREATED', 'PRODUCT'),
    createProduct
  );

router.route('/:id')
  .get(VIEW, getProductById)
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
