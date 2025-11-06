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
exports.validateCoupon = async (req, res) => {
  try {
    const { code, orderValue, productIds, userId } = req.body;
    
    const coupon = await Coupon.findOne({ code: code.toUpperCase() });
    
    if (!coupon) {
      return res.status(404).json({
        success: false,
        message: 'Invalid coupon code'
      });
    }
    
    // Check if coupon is active
    if (!coupon.isActive) {
      return res.status(400).json({
        success: false,
        message: 'This coupon is no longer active'
      });
    }
    
    // Check validity dates
    const now = new Date();
    if (now < coupon.validFrom) {
      return res.status(400).json({
        success: false,
        message: 'This coupon is not yet valid'
      });
    }
    
    if (now > coupon.validUntil) {
      return res.status(400).json({
        success: false,
        message: 'This coupon has expired'
      });
    }
    
    // Check usage limit
    if (coupon.usageLimit && coupon.usageCount >= coupon.usageLimit) {
      return res.status(400).json({
        success: false,
        message: 'This coupon has reached its usage limit'
      });
    }
    
    // Check minimum order value
    if (orderValue < coupon.minOrderValue) {
      return res.status(400).json({
        success: false,
        message: `Minimum order value of ₹${coupon.minOrderValue} required`
      });
    }
    
    // Check applicable products
    if (coupon.applicableProducts.length > 0) {
      const hasApplicableProduct = productIds.some(id => 
        coupon.applicableProducts.includes(id)
      );
      
      if (!hasApplicableProduct) {
        return res.status(400).json({
          success: false,
          message: 'This coupon is not applicable to the products in your cart'
        });
      }
    }
    
    // Calculate discount
    let discount = 0;
    if (coupon.discountType === 'percentage') {
      discount = (orderValue * coupon.discountValue) / 100;
      if (coupon.maxDiscount && discount > coupon.maxDiscount) {
        discount = coupon.maxDiscount;
      }
    } else {
      discount = coupon.discountValue;
    }
    
    res.json({
      success: true,
      message: 'Coupon is valid',
      data: {
        coupon: {
          code: coupon.code,
          discountType: coupon.discountType,
          discountValue: coupon.discountValue
        },
        discount: Math.round(discount)
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
    .select('-usageCount -perUserLimit -applicableProducts -applicableCategories')
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

// @desc    Apply coupon and track usage
// @route   POST /api/coupons/apply
// @access  Private
exports.applyCoupon = async (req, res) => {
  try {
    const { couponId, orderId } = req.body;
    const userId = req.user._id;
    
    const coupon = await Coupon.findById(couponId);
    
    if (!coupon) {
      return res.status(404).json({
        success: false,
        message: 'Coupon not found'
      });
    }
    
    // Check if coupon is still valid
    if (!coupon.isActive) {
      return res.status(400).json({
        success: false,
        message: 'This coupon is no longer active'
      });
    }
    
    const now = new Date();
    if (now < coupon.validFrom || now > coupon.validUntil) {
      return res.status(400).json({
        success: false,
        message: 'This coupon has expired or is not yet valid'
      });
    }
    
    // Check usage limit
    if (coupon.usageLimit && coupon.usageCount >= coupon.usageLimit) {
      return res.status(400).json({
        success: false,
        message: 'This coupon has reached its usage limit'
      });
    }
    
    // Increment usage count
    coupon.usageCount += 1;
    await coupon.save();
    
    res.json({
      success: true,
      message: 'Coupon applied successfully',
      data: {
        couponId: coupon._id,
        code: coupon.code,
        orderId
      }
    });
  } catch (error) {
    console.error('Error applying coupon:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to apply coupon',
      error: error.message
    });
  }
};

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
