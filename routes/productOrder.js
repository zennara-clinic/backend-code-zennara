const express = require('express');
const router = express.Router();
const {
  createOrder,
  getUserOrders,
  getOrder,
  getOrderByNumber,
  cancelOrder,
  returnOrder,
  updateOrderStatus
} = require('../controllers/productOrderController');
const { protect } = require('../middleware/auth');

// Protected routes - require authentication
router.use(protect);

router.post('/', createOrder);
router.get('/', getUserOrders);
router.get('/number/:orderNumber', getOrderByNumber);
router.get('/:id', getOrder);
router.post('/:id/cancel', cancelOrder);
router.post('/:id/return', returnOrder);
router.put('/:id/status', updateOrderStatus);

module.exports = router;
