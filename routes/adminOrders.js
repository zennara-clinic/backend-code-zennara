const express = require('express');
const router = express.Router();
const {
  getAllOrders,
  getOrderById,
  updateOrderStatus,
  getOrderStats,
  deleteOrder
} = require('../controllers/adminOrderController');
const {
  approveReturn,
  rejectReturn
} = require('../controllers/productOrderController');
const { protectAdmin, requireRole, auditLog } = require('../middleware/auth');
const { adminSensitiveOperationsLimiter } = require('../middleware/rateLimiter');

// Admin authentication middleware
router.use(protectAdmin);

// Order routes
router.get('/', getAllOrders);
router.get('/stats', getOrderStats);
router.get('/:id', getOrderById);
router.put('/:id/status',
  requireRole('super_admin', 'admin'),
  auditLog('ORDER_STATUS_UPDATED', 'ORDER'),
  updateOrderStatus
);
router.put('/:id/approve-return',
  requireRole('super_admin', 'admin'),
  auditLog('RETURN_APPROVED', 'ORDER'),
  approveReturn
);
router.put('/:id/reject-return',
  requireRole('super_admin', 'admin'),
  auditLog('RETURN_REJECTED', 'ORDER'),
  rejectReturn
);
router.delete('/:id',
  requireRole('super_admin', 'admin'),
  adminSensitiveOperationsLimiter,
  auditLog('ORDER_DELETED', 'ORDER'),
  deleteOrder
);

module.exports = router;
