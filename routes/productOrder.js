const express = require('express');
const router = express.Router();
const {
  createOrder,
  getUserOrders,
  getOrder,
  getOrderByNumber,
  cancelOrder,
  updateOrderStatus
} = require('../controllers/productOrderController');
const { protect } = require('../middleware/auth');

// Protected routes - require authentication
router.use(protect);

router.post('/', createOrder);
router.get('/', getUserOrders);
router.get('/number/:orderNumber', getOrderByNumber);
router.get('/:id', getOrder);
router.put('/:id/cancel', cancelOrder);
router.put('/:id/status', updateOrderStatus);

module.exports = router;
