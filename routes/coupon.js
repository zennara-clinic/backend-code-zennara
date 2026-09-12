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
// Opening the Coupons page is a read; only editing needs `coupons.manage`.
const VIEW = requirePermission('coupons.view', 'coupons.manage');

// Public routes
router.get('/available', getAvailableCoupons);
router.post('/validate', validateCoupon);

// Retired: a coupon use is spent when a paid order carrying it is created, not
// when a phone says so. The handler answers 410 for older app builds; the
// mount stays `protect`ed so the 410 is all an anonymous caller can reach.
router.post('/apply', protect, applyCoupon);

// Admin routes - require admin authentication
// Statistics route (must be before /:id)
router.get('/statistics', protectAdmin, VIEW, getCouponStatistics);

// CRUD routes
router.route('/')
  .get(protectAdmin, VIEW, getAllCoupons)
  .post(protectAdmin, MANAGE, createCoupon);

router.route('/:id')
  .get(protectAdmin, VIEW, getCouponById)
  .put(protectAdmin, MANAGE, updateCoupon)
  .delete(protectAdmin, MANAGE, deleteCoupon);

module.exports = router;
