const Coupon = require('../models/Coupon');
const Product = require('../models/Product');

// @desc    Get all coupons
// @route   GET /api/admin/coupons
// @access  Private (Admin)
exports.getAllCoupons = async (req, res) => {
  try {
    const { search, isActive, discountType, status } = req.query;
    
    let query = {};
    
    // Search filter
    if (search) {
      query.code = { $regex: search, $options: 'i' };
    }
    
    // Active filter
    if (isActive !== undefined) {
      query.isActive = isActive === 'true';
    }
    
    // Discount type filter
    if (discountType) {
      query.discountType = discountType;
    }
    
    // Status filter (expired, active, upcoming)
    if (status) {
      const now = new Date();
      if (status === 'expired') {
        query.validUntil = { $lt: now };
      } else if (status === 'active') {
        query.validFrom = { $lte: now };
        query.validUntil = { $gte: now };
      } else if (status === 'upcoming') {
        query.validFrom = { $gt: now };
      }
    }
    
    const coupons = await Coupon.find(query)
      .populate('applicableProducts', 'name price image')
      .sort({ createdAt: -1 });
    
    res.json({
      success: true,
      data: coupons
    });
  } catch (error) {
    console.error('Error fetching coupons:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch coupons',
      error: error.message
    });
  }
};

// @desc    Get single coupon
// @route   GET /api/admin/coupons/:id
// @access  Private (Admin)
exports.getCouponById = async (req, res) => {
  try {
    const coupon = await Coupon.findById(req.params.id)
      .populate('applicableProducts', 'name price image formulation');
    
    if (!coupon) {
      return res.status(404).json({
        success: false,
        message: 'Coupon not found'
      });
    }
    
    res.json({
      success: true,
      data: coupon
    });
  } catch (error) {
    console.error('Error fetching coupon:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch coupon',
      error: error.message
    });
  }
};

// @desc    Validate coupon code
// @route   POST /api/coupons/validate
// @access  Public
/*
 * This screen must give the SAME answer checkout will.
 *
 * It used to re-implement the rules — and imperfectly: it never looked at
 * applicableCategories (so a Skincare-only coupon validated against any cart)
 * and never looked at perUserLimit, while utils/orderPricing.validateCouponForOrder,
 * which is what actually prices the order, checks both. A guest could be told
 * "coupon is valid", see a discount, and then be charged the full amount.
 * There is now one implementation and this is a thin wrapper over it.
 */
exports.validateCoupon = async (req, res) => {
  try {
    const { code, orderValue, productIds, userId } = req.body;
    if (!code) {
      return res.status(400).json({ success: false, message: 'Enter a coupon code' });
    }

    const { validateCouponForOrder } = require('../utils/orderPricing');
    const result = await validateCouponForOrder(
      code,
      Number(orderValue) || 0,
      Array.isArray(productIds) ? productIds : [],
      // The route is public, so the caller's own id is the best available
      // owner for the per-guest check. Claiming somebody else's id can only
      // make this screen stricter — no money is moved here.
      { userId: req.user?._id || userId || null },
    );

    if (!result.ok) {
      const unknown = /not recognised/i.test(result.reason || '');
      return res.status(unknown ? 404 : 400).json({
        success: false,
        message: result.reason || 'Invalid coupon code',
      });
    }

    // The app shows the coupon's own terms next to the discount, so these two
    // fields still come from the record itself.
    const coupon = await Coupon.findOne({ code: result.code });

    res.json({
      success: true,
      message: 'Coupon is valid',
      data: {
        coupon: {
          code: result.code,
          discountType: coupon?.discountType,
          discountValue: coupon?.discountValue
        },
        discount: result.discount
      }
    });
  } catch (error) {
    console.error('Error validating coupon:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to validate coupon',
      error: error.message
    });
  }
};

// @desc    Create new coupon
// @route   POST /api/admin/coupons
// @access  Private (Admin)
exports.createCoupon = async (req, res) => {
  try {
    const {
      code,
      description,
      discountType,
      discountValue,
      minOrderValue,
      maxDiscount,
      usageLimit,
      perUserLimit,
      validFrom,
      validUntil,
      applicableProducts,
      applicableCategories,
      isActive,
      isPublic
    } = req.body;
    
    // Check if coupon code already exists
    const existingCoupon = await Coupon.findOne({ code: code.toUpperCase() });
    if (existingCoupon) {
      return res.status(400).json({
        success: false,
        message: 'Coupon code already exists'
      });
    }
    
    // Validate discount value
    if (discountType === 'percentage' && discountValue > 100) {
      return res.status(400).json({
        success: false,
        message: 'Percentage discount cannot exceed 100%'
      });
    }
    
    const coupon = await Coupon.create({
      code: code.toUpperCase(),
      description,
      discountType,
      discountValue,
      minOrderValue,
      maxDiscount,
      usageLimit,
      perUserLimit,
      validFrom,
      validUntil,
      applicableProducts,
      applicableCategories,
      isActive,
      isPublic
    });
    
    res.status(201).json({
      success: true,
      message: 'Coupon created successfully',
      data: coupon
    });
  } catch (error) {
    console.error('Error creating coupon:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create coupon',
      error: error.message
    });
  }
};

// @desc    Update coupon
// @route   PUT /api/admin/coupons/:id
// @access  Private (Admin)
exports.updateCoupon = async (req, res) => {
  try {
    const coupon = await Coupon.findById(req.params.id);
    
    if (!coupon) {
      return res.status(404).json({
        success: false,
        message: 'Coupon not found'
      });
    }
    
    const {
      code,
      description,
      discountType,
      discountValue,
      minOrderValue,
      maxDiscount,
      usageLimit,
      perUserLimit,
      validFrom,
      validUntil,
      applicableProducts,
      applicableCategories,
      isActive,
      isPublic
    } = req.body;
    
    // If code is being changed, check for duplicates
    if (code && code.toUpperCase() !== coupon.code) {
      const existingCoupon = await Coupon.findOne({ code: code.toUpperCase() });
      if (existingCoupon) {
        return res.status(400).json({
          success: false,
          message: 'Coupon code already exists'
        });
      }
      coupon.code = code.toUpperCase();
    }
    
    // Validate discount value
    if (discountType === 'percentage' && discountValue > 100) {
      return res.status(400).json({
        success: false,
        message: 'Percentage discount cannot exceed 100%'
      });
    }
    
    coupon.description = description !== undefined ? description : coupon.description;
    coupon.discountType = discountType || coupon.discountType;
    coupon.discountValue = discountValue !== undefined ? discountValue : coupon.discountValue;
    coupon.minOrderValue = minOrderValue !== undefined ? minOrderValue : coupon.minOrderValue;
    coupon.maxDiscount = maxDiscount !== undefined ? maxDiscount : coupon.maxDiscount;
    coupon.usageLimit = usageLimit !== undefined ? usageLimit : coupon.usageLimit;
    coupon.perUserLimit = perUserLimit !== undefined ? perUserLimit : coupon.perUserLimit;
    coupon.validFrom = validFrom || coupon.validFrom;
    coupon.validUntil = validUntil || coupon.validUntil;
    coupon.applicableProducts = applicableProducts !== undefined ? applicableProducts : coupon.applicableProducts;
    coupon.applicableCategories = applicableCategories !== undefined ? applicableCategories : coupon.applicableCategories;
    coupon.isActive = isActive !== undefined ? isActive : coupon.isActive;
    coupon.isPublic = isPublic !== undefined ? isPublic : coupon.isPublic;
    
    await coupon.save();
    
    res.json({
      success: true,
      message: 'Coupon updated successfully',
      data: coupon
    });
  } catch (error) {
    console.error('Error updating coupon:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update coupon',
      error: error.message
    });
  }
};

// @desc    Delete coupon
// @route   DELETE /api/admin/coupons/:id
// @access  Private (Admin)
exports.deleteCoupon = async (req, res) => {
  try {
    const coupon = await Coupon.findById(req.params.id);
    
    if (!coupon) {
      return res.status(404).json({
        success: false,
        message: 'Coupon not found'
      });
    }
    
    await coupon.deleteOne();
    
    res.json({
      success: true,
      message: 'Coupon deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting coupon:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete coupon',
      error: error.message
    });
  }
};

// @desc    Get available coupons for users
// @route   GET /api/coupons/available
// @access  Public
exports.getAvailableCoupons = async (req, res) => {
  try {
    const now = new Date();
    
    const coupons = await Coupon.find({
      isActive: true,
      isPublic: true,
      validFrom: { $lte: now },
      validUntil: { $gte: now },
      $or: [
        { usageLimit: null },
        { $expr: { $lt: ['$usageCount', '$usageLimit'] } }
      ]
    })
    // The app needs the scope to say "applies to Skincare" and to pre-check the cart.
    .select('-usageCount -perUserLimit')
    .sort({ discountValue: -1, createdAt: -1 });
    
    // Filter out any coupons with missing required fields
    const validCoupons = coupons.filter(coupon => {
      return (
        coupon._id &&
        coupon.code &&
        coupon.discountType &&
        typeof coupon.discountValue === 'number' &&
        coupon.validUntil
      );
    });
    
    res.json({
      success: true,
      data: validCoupons
    });
  } catch (error) {
    console.error('Error fetching available coupons:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch available coupons',
      error: error.message
    });
  }
};

/*
 * POST /api/coupons/apply — RETIRED 2026-09-12. Answers 410.
 *
 * It took a coupon id from the phone, checked nothing about who was asking or
 * what they were buying, and incremented `usageCount`. Any client could burn a
 * limited coupon to exhaustion with a loop, and because no order was recorded
 * against the use, `perUserLimit` had nothing to count and was never enforced
 * anywhere. A coupon use is now spent in exactly one place — the product-order
 * payment verification, once an order carrying the coupon exists against a
 * captured payment (paymentController.verifyProductPayment).
 *
 * Kept as a 410 rather than deleted so an app build that still calls it gets
 * an answer it can recognise instead of a 404 that reads like an outage.
 */
exports.applyCoupon = async (req, res) => res.status(410).json({
  success: false,
  code: 'COUPON_APPLY_RETIRED',
  message: 'Coupons are applied when your order is paid for — there is nothing to do here.',
});

// @desc    Get coupon statistics
// @route   GET /api/admin/coupons/statistics
// @access  Private (Admin)
exports.getCouponStatistics = async (req, res) => {
  try {
    const now = new Date();
    
    const totalCoupons = await Coupon.countDocuments();
    const activeCoupons = await Coupon.countDocuments({
      isActive: true,
      validFrom: { $lte: now },
      validUntil: { $gte: now }
    });
    const expiredCoupons = await Coupon.countDocuments({
      validUntil: { $lt: now }
    });
    const upcomingCoupons = await Coupon.countDocuments({
      validFrom: { $gt: now }
    });
    
    // Get most used coupons
    const mostUsed = await Coupon.find()
      .sort({ usageCount: -1 })
      .limit(5)
      .select('code usageCount discountType discountValue');
    
    res.json({
      success: true,
      data: {
        total: totalCoupons,
        active: activeCoupons,
        expired: expiredCoupons,
        upcoming: upcomingCoupons,
        mostUsed
      }
    });
  } catch (error) {
    console.error('Error fetching coupon statistics:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch coupon statistics',
      error: error.message
    });
  }
};
