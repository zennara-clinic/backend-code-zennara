const Payment = require('../models/Payment');
const ProductOrder = require('../models/ProductOrder');
const Product = require('../models/Product');
const Address = require('../models/Address');
const User = require('../models/User');
const razorpayService = require('../services/razorpayService');
const NotificationHelper = require('../utils/notificationHelper');

// @desc    Create Razorpay order for product purchase
// @route   POST /api/payments/product/create
// @access  Private
exports.createProductOrderPayment = async (req, res) => {
  try {
    const { amount, orderData } = req.body;
    
    console.log('💳 Creating product payment order for user:', req.user._id);
    console.log('💰 Amount:', amount);
    
    // Validate amount
    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Invalid payment amount'
      });
    }
    
    // Validate order data
    if (!orderData || !orderData.items || orderData.items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Order data is required'
      });
    }
    
    // Generate receipt (max 40 chars for Razorpay)
    const timestamp = Date.now().toString().slice(-10);
    const userIdSuffix = req.user._id.toString().slice(-10);
    const receipt = `PROD_${timestamp}_${userIdSuffix}`;
    
    // Create Razorpay order
    const razorpayOrder = await razorpayService.createOrder(
      amount,
      'INR',
      receipt,
      {
        orderType: 'product',
        userId: req.user._id.toString(),
        itemCount: orderData.items.length
      }
    );
    
    // Create payment record in database
    const payment = await Payment.create({
      userId: req.user._id,
      orderType: 'ProductOrder',
      razorpayOrderId: razorpayOrder.id,
      amount: amount,
      currency: 'INR',
      status: 'created',
      metadata: {
        receipt: receipt,
        orderData: orderData
      }
    });
    
    console.log('✅ Payment record created:', payment._id);
    
    res.json({
      success: true,
      data: {
        orderId: razorpayOrder.id,
        amount: razorpayOrder.amount,
        currency: razorpayOrder.currency,
        keyId: process.env.RAZORPAY_KEY_ID,
        paymentId: payment._id
      }
    });
  } catch (error) {
    console.error('❌ Create product payment error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create payment order',
      error: error.message
    });
  }
};

// @desc    Verify product payment and create order
// @route   POST /api/payments/product/verify
// @access  Private
exports.verifyProductPayment = async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      orderData
    } = req.body;
    
    console.log('🔍 Verifying product payment:', razorpay_payment_id);
    
    // Verify signature
    const isValid = razorpayService.verifySignature(
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    );
    
    if (!isValid) {
      console.error('❌ Invalid payment signature');
      return res.status(400).json({
        success: false,
        message: 'Invalid payment signature'
      });
    }
    
    // Update payment record
    const payment = await Payment.findOne({ razorpayOrderId: razorpay_order_id });
    
    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Payment record not found'
      });
    }
    
    payment.razorpayPaymentId = razorpay_payment_id;
    payment.razorpaySignature = razorpay_signature;
    payment.status = 'captured';
    await payment.save();
    
    console.log('✅ Payment verified and captured');
    
    // Create product order
    console.log('📦 Creating product order...');
    
    // Validate and get address
    const address = await Address.findOne({
      _id: orderData.addressId,
      userId: req.user._id
    });
    
    if (!address) {
      return res.status(404).json({
        success: false,
        message: 'Address not found'
      });
    }
    
    // Validate and process items
    let calculatedSubtotal = 0;
    
    // First pass: validate all items
    const itemsToProcess = [];
    for (const item of orderData.items) {
      if (!item.productId || !item.quantity || item.quantity <= 0) {
        return res.status(400).json({
          success: false,
          message: 'Invalid item data in cart'
        });
      }
      
      const product = await Product.findById(item.productId);
      
      if (!product) {
        return res.status(404).json({
          success: false,
          message: `Product not found: ${item.productId}`
        });
      }
      
      if (product.stock < item.quantity) {
        return res.status(400).json({
          success: false,
          message: `Insufficient stock for ${product.name}. Available: ${product.stock}`,
          availableStock: product.stock
        });
      }
      
      calculatedSubtotal += product.price * item.quantity;
      itemsToProcess.push({ product, quantity: item.quantity });
    }
    
    // Second pass: atomically reduce stock
    const processedItems = [];
    for (const { product, quantity } of itemsToProcess) {
      const updated = await Product.findOneAndUpdate(
        { 
          _id: product._id, 
          stock: { $gte: quantity },
          isActive: true 
        },
        { 
          $inc: { stock: -quantity } 
        },
        { 
          new: true,
          runValidators: true 
        }
      );
      
      if (!updated) {
        // Rollback previously processed items
        for (const processed of processedItems) {
          await Product.findByIdAndUpdate(
            processed.productId,
            { $inc: { stock: processed.quantity } }
          );
        }
        
        return res.status(400).json({
          success: false,
          message: `Stock changed for ${product.name}. Please try again.`,
          requiresRefresh: true
        });
      }
      
      // Add processed item with complete information
      const price = product.price;
      const subtotal = price * quantity;
      
      processedItems.push({
        productId: product._id,
        productName: product.name,
        productImage: product.image,
        quantity: quantity,
        price: price,
        subtotal: subtotal
      });
    }
    
    // Generate order number
    const orderCount = await ProductOrder.countDocuments();
    const orderNumber = `ORD${Date.now()}${String(orderCount + 1).padStart(4, '0')}`;
    
    // Create product order
    const order = await ProductOrder.create({
      userId: req.user._id,
      orderNumber,
      items: processedItems,
      shippingAddress: {
        addressId: address._id,
        fullName: address.fullName,
        phone: address.phone,
        addressLine1: address.addressLine1,
        addressLine2: address.addressLine2,
        city: address.city,
        state: address.state,
        postalCode: address.postalCode,
        country: address.country
      },
      pricing: orderData.pricing,
      coupon: orderData.coupon,
      paymentMethod: 'Razorpay',
      paymentStatus: 'Paid',
      notes: orderData.notes || ''
    });
    
    // Link payment to order
    payment.orderId = order._id;
    await payment.save();
    
    // Populate order details
    const populatedOrder = await ProductOrder.findById(order._id)
      .populate('userId', 'fullName email phone')
      .populate('items.productId');
    
    console.log('✅ Product order created:', populatedOrder.orderNumber);
    
    // Create notification for admin
    try {
      await NotificationHelper.orderCreated({
        _id: populatedOrder._id,
        orderNumber: populatedOrder.orderNumber,
        totalAmount: populatedOrder.pricing.total,
        shippingAddress: { name: populatedOrder.shippingAddress.fullName }
      });
    } catch (notifError) {
      console.error('⚠️ Failed to create notification:', notifError);
    }
    
    res.json({
      success: true,
      message: 'Payment verified and order created successfully',
      data: populatedOrder
    });
  } catch (error) {
    console.error('❌ Verify product payment error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to verify payment',
      error: error.message
    });
  }
};

// @desc    Create Razorpay order for Zen membership
// @route   POST /api/payments/membership/create
// @access  Private
exports.createMembershipPayment = async (req, res) => {
  try {
    const amount = 1999; // Zen membership price (₹1999)
    
    console.log('👑 Creating membership payment for user:', req.user._id);
    
    // Check if user is already a Zen member
    if (req.user.memberType === 'Zen Member') {
      // Check if membership is still active
      if (req.user.zenMembershipExpiryDate && new Date(req.user.zenMembershipExpiryDate) > new Date()) {
        return res.status(400).json({
          success: false,
          message: 'You already have an active Zen membership'
        });
      }
    }
    
    // Generate receipt (max 40 chars for Razorpay)
    const timestamp = Date.now().toString().slice(-10);
    const userIdSuffix = req.user._id.toString().slice(-10);
    const receipt = `ZEN_${timestamp}_${userIdSuffix}`;
    
    // Create Razorpay order
    const razorpayOrder = await razorpayService.createOrder(
      amount,
      'INR',
      receipt,
      {
        orderType: 'membership',
        userId: req.user._id.toString(),
        membershipType: 'Zen Member'
      }
    );
    
    // Create payment record in database
    const payment = await Payment.create({
      userId: req.user._id,
      orderType: 'ZenMembership',
      razorpayOrderId: razorpayOrder.id,
      amount: amount,
      currency: 'INR',
      status: 'created',
      metadata: {
        receipt: receipt,
        membershipType: 'Zen Member',
        duration: '30 days'
      }
    });
    
    console.log('✅ Membership payment record created:', payment._id);
    
    res.json({
      success: true,
      data: {
        orderId: razorpayOrder.id,
        amount: razorpayOrder.amount,
        currency: razorpayOrder.currency,
        keyId: process.env.RAZORPAY_KEY_ID,
        paymentId: payment._id
      }
    });
  } catch (error) {
    console.error('❌ Create membership payment error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create membership payment',
      error: error.message
    });
  }
};

// @desc    Verify membership payment and upgrade user
// @route   POST /api/payments/membership/verify
// @access  Private
exports.verifyMembershipPayment = async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    } = req.body;
    
    console.log('🔍 Verifying membership payment:', razorpay_payment_id);
    
    // Verify signature
    const isValid = razorpayService.verifySignature(
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    );
    
    if (!isValid) {
      console.error('❌ Invalid payment signature');
      return res.status(400).json({
        success: false,
        message: 'Invalid payment signature'
      });
    }
    
    // Update payment record
    const payment = await Payment.findOne({ razorpayOrderId: razorpay_order_id });
    
    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Payment record not found'
      });
    }
    
    payment.razorpayPaymentId = razorpay_payment_id;
    payment.razorpaySignature = razorpay_signature;
    payment.status = 'captured';
    await payment.save();
    
    console.log('✅ Membership payment verified');
    
    // Upgrade user to Zen Member
    const user = await User.findById(req.user._id);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    user.memberType = 'Zen Member';
    user.zenMembershipStartDate = new Date();
    user.zenMembershipExpiryDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days from now
    user.zenMembershipAutoRenew = true;
    
    await user.save();
    
    console.log('👑 User upgraded to Zen Member:', user.email);
    
    // Return updated user data
    const updatedUser = {
      id: user._id,
      email: user.email,
      fullName: user.fullName,
      phone: user.phone,
      location: user.location,
      dateOfBirth: user.dateOfBirth,
      gender: user.gender,
      memberType: user.memberType,
      zenMembershipStartDate: user.zenMembershipStartDate,
      zenMembershipExpiryDate: user.zenMembershipExpiryDate,
      zenMembershipAutoRenew: user.zenMembershipAutoRenew,
      profilePicture: user.profilePicture?.url || null,
      isVerified: user.isVerified,
      createdAt: user.createdAt
    };
    
    res.json({
      success: true,
      message: 'Membership payment verified and activated',
      data: updatedUser
    });
  } catch (error) {
    console.error('❌ Verify membership payment error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to verify membership payment',
      error: error.message
    });
  }
};

// @desc    Handle Razorpay webhook
// @route   POST /api/payments/webhook
// @access  Public (but verified)
exports.handleWebhook = async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    
    if (!webhookSecret) {
      console.error('❌ Webhook secret not configured');
      return res.status(500).send('Webhook secret not configured');
    }
    
    // Verify webhook signature
    const isValid = razorpayService.verifyWebhookSignature(
      JSON.stringify(req.body),
      signature,
      webhookSecret
    );
    
    if (!isValid) {
      console.error('❌ Invalid webhook signature');
      return res.status(400).send('Invalid signature');
    }
    
    const event = req.body.event;
    const payload = req.body.payload;
    
    console.log('📨 Webhook received:', event);
    
    // Handle different webhook events
    switch (event) {
      case 'payment.captured':
        await handlePaymentCaptured(payload.payment.entity);
        break;
      
      case 'payment.failed':
        await handlePaymentFailed(payload.payment.entity);
        break;
      
      case 'order.paid':
        console.log('✅ Order paid event received');
        break;
      
      default:
        console.log('ℹ️ Unhandled webhook event:', event);
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Webhook handler error:', error);
    res.status(500).send('Webhook handler error');
  }
};

// Helper function to handle payment captured
async function handlePaymentCaptured(paymentEntity) {
  try {
    console.log('✅ Payment captured:', paymentEntity.id);
    
    const payment = await Payment.findOne({
      razorpayPaymentId: paymentEntity.id
    });
    
    if (payment) {
      payment.status = 'captured';
      payment.method = paymentEntity.method;
      await payment.save();
      console.log('💾 Payment status updated to captured');
    }
  } catch (error) {
    console.error('❌ Error handling payment captured:', error);
  }
}

// Helper function to handle payment failed
async function handlePaymentFailed(paymentEntity) {
  try {
    console.log('❌ Payment failed:', paymentEntity.id);
    
    const payment = await Payment.findOne({
      razorpayOrderId: paymentEntity.order_id
    });
    
    if (payment) {
      payment.status = 'failed';
      payment.failureReason = paymentEntity.error_description || 'Payment failed';
      await payment.save();
      console.log('💾 Payment status updated to failed');
    }
  } catch (error) {
    console.error('❌ Error handling payment failed:', error);
  }
}

module.exports = exports;
