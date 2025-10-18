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
const { protectAdmin } = require('../middleware/auth');

// Admin authentication middleware
router.use(protectAdmin);

// Order routes
router.get('/', getAllOrders);
router.get('/stats', getOrderStats);
router.get('/:id', getOrderById);
router.put('/:id/status', updateOrderStatus);
router.put('/:id/approve-return', approveReturn);
router.put('/:id/reject-return', rejectReturn);
router.delete('/:id', deleteOrder);

module.exports = router;
