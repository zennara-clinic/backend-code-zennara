const express = require('express');
const router = express.Router();
const {
  getAllCoupons,
  getCouponById,
  validateCoupon,
  createCoupon,
  updateCoupon,
  deleteCoupon,
  getCouponStatistics,
  getAvailableCoupons,
  applyCoupon
} = require('../controllers/couponController');
const { protectAdmin, protect } = require('../middleware/auth');

// Public routes
router.get('/available', getAvailableCoupons);
router.post('/validate', validateCoupon);

// Protected user routes
router.post('/apply', protect, applyCoupon);

// Admin routes - require admin authentication
// Statistics route (must be before /:id)
router.get('/statistics', protectAdmin, getCouponStatistics);

// CRUD routes
router.route('/')
  .get(protectAdmin, getAllCoupons)
  .post(protectAdmin, createCoupon);

router.route('/:id')
  .get(protectAdmin, getCouponById)
  .put(protectAdmin, updateCoupon)
  .delete(protectAdmin, deleteCoupon);

module.exports = router;
