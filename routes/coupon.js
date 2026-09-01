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

// Protected user routes
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
