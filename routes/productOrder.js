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
const { orderLimiter } = require('../middleware/rateLimiter');
const { validateObjectId } = require('../middleware/sanitizer');

// Protected routes - require authentication
router.use(protect);

// Apply rate limiting to order creation
router.post('/', orderLimiter, createOrder);
router.get('/', getUserOrders);
router.get('/number/:orderNumber', getOrderByNumber);

// Validate ObjectId before processing
router.get('/:id', validateObjectId('id'), getOrder);
router.post('/:id/cancel', validateObjectId('id'), cancelOrder);
router.post('/:id/return', validateObjectId('id'), returnOrder);
router.put('/:id/status', validateObjectId('id'), updateOrderStatus);

module.exports = router;
