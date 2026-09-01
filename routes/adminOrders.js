const express = require('express');
const router = express.Router();
const {
  getAllOrders,
  getOrderById,
  updateOrderStatus,
  markDeliveryFailed,
  assignDelivery,
  getOrderStats,
  deleteOrder
} = require('../controllers/adminOrderController');
const {
  approveReturn,
  completeReturn,
  rejectReturn
} = require('../controllers/productOrderController');
const {
  initiateRefund,
  completeRefund,
  getCustomerBankDetails
} = require('../controllers/refundController');
const { protectAdmin, requireRole, requirePermission, auditLog } = require('../middleware/auth');
const { adminSensitiveOperationsLimiter } = require('../middleware/rateLimiter');

// Admin authentication middleware
router.use(protectAdmin);

// Order routes
router.get('/', getAllOrders);
router.get('/stats', getOrderStats);
router.get('/:id', getOrderById);
router.put('/:id/status',
  requirePermission('orders.manage'),
  auditLog('ORDER_STATUS_UPDATED', 'ORDER'),
  updateOrderStatus
);
router.put('/:id/delivery-failed',
  requirePermission('orders.manage'),
  auditLog('DELIVERY_FAILED', 'ORDER'),
  markDeliveryFailed
);
router.put('/:id/assign-delivery',
  requirePermission('orders.manage'),
  auditLog('DELIVERY_ASSIGNED', 'ORDER'),
  assignDelivery
);
router.put('/:id/approve-return',
  requirePermission('orders.manage'),
  auditLog('RETURN_APPROVED', 'ORDER'),
  approveReturn
);
router.put('/:id/reject-return',
  requirePermission('orders.manage'),
  auditLog('RETURN_REJECTED', 'ORDER'),
  rejectReturn
);
router.put('/:id/complete-return',
  requirePermission('orders.manage'),
  adminSensitiveOperationsLimiter,
  auditLog('RETURN_COMPLETED', 'ORDER'),
  completeReturn
);
router.delete('/:id',
  requirePermission('orders.manage'),
  adminSensitiveOperationsLimiter,
  auditLog('ORDER_DELETED', 'ORDER'),
  deleteOrder
);

// Refund routes
router.post('/:id/initiate-refund',
  requirePermission('orders.refund'),
  adminSensitiveOperationsLimiter,
  auditLog('REFUND_INITIATED', 'ORDER'),
  initiateRefund
);
router.put('/:id/complete-refund',
  requirePermission('orders.refund'),
  adminSensitiveOperationsLimiter,
  auditLog('REFUND_COMPLETED', 'ORDER'),
  completeRefund
);
router.get('/user/:userId/bank-details',
  requirePermission('orders.refund'),
  getCustomerBankDetails
);

module.exports = router;
