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
const { protectAdmin, protect, requireRole, requirePermission } = require('../middleware/auth');
const MANAGE = requirePermission('coupons.manage');

// Public routes
router.get('/available', getAvailableCoupons);
router.post('/validate', validateCoupon);

// Protected user routes
router.post('/apply', protect, applyCoupon);

// Admin routes - require admin authentication
// Statistics route (must be before /:id)
router.get('/statistics', protectAdmin, MANAGE, getCouponStatistics);

// CRUD routes
router.route('/')
  .get(protectAdmin, MANAGE, getAllCoupons)
  .post(protectAdmin, MANAGE, createCoupon);

router.route('/:id')
  .get(protectAdmin, MANAGE, getCouponById)
  .put(protectAdmin, MANAGE, updateCoupon)
  .delete(protectAdmin, MANAGE, deleteCoupon);

module.exports = router;
