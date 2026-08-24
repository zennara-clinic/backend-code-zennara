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
const { protectAdmin, requireRole, auditLog } = require('../middleware/auth');
const { adminSensitiveOperationsLimiter } = require('../middleware/rateLimiter');

// Admin authentication middleware
router.use(protectAdmin);

// Order routes
router.get('/', getAllOrders);
router.get('/stats', getOrderStats);
router.get('/:id', getOrderById);
router.put('/:id/status',
  requireRole('super_admin'),
  auditLog('ORDER_STATUS_UPDATED', 'ORDER'),
  updateOrderStatus
);
router.put('/:id/delivery-failed',
  requireRole('super_admin'),
  auditLog('DELIVERY_FAILED', 'ORDER'),
  markDeliveryFailed
);
router.put('/:id/assign-delivery',
  requireRole('super_admin'),
  auditLog('DELIVERY_ASSIGNED', 'ORDER'),
  assignDelivery
);
router.put('/:id/approve-return',
  requireRole('super_admin'),
  auditLog('RETURN_APPROVED', 'ORDER'),
  approveReturn
);
router.put('/:id/reject-return',
  requireRole('super_admin'),
  auditLog('RETURN_REJECTED', 'ORDER'),
  rejectReturn
);
router.put('/:id/complete-return',
  requireRole('super_admin'),
  adminSensitiveOperationsLimiter,
  auditLog('RETURN_COMPLETED', 'ORDER'),
  completeReturn
);
router.delete('/:id',
  requireRole('super_admin'),
  adminSensitiveOperationsLimiter,
  auditLog('ORDER_DELETED', 'ORDER'),
  deleteOrder
);

// Refund routes
router.post('/:id/initiate-refund',
  requireRole('super_admin'),
  adminSensitiveOperationsLimiter,
  auditLog('REFUND_INITIATED', 'ORDER'),
  initiateRefund
);
router.put('/:id/complete-refund',
  requireRole('super_admin'),
  adminSensitiveOperationsLimiter,
  auditLog('REFUND_COMPLETED', 'ORDER'),
  completeRefund
);
router.get('/user/:userId/bank-details',
  requireRole('super_admin'),
  getCustomerBankDetails
);

module.exports = router;
