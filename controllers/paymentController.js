const Payment = require('../models/Payment');
const mongoose = require('mongoose');
const ProductOrder = require('../models/ProductOrder');
const Product = require('../models/Product');
const Address = require('../models/Address');
const User = require('../models/User');
const razorpayService = require('../services/razorpayService');
const NotificationHelper = require('../utils/notificationHelper');
const { validateBranchBooking, validateBranchSession } = require('../utils/branchSchedule');
const { clinicDateKey } = require('../utils/bookingTime');
const { computeOrderPricing } = require('../utils/orderPricing');

class PaymentFlowError extends Error {
  constructor(status, message, code = 'PAYMENT_VERIFICATION_FAILED') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const paymentErrorResponse = (res, error, fallbackMessage) => {
  const status = error instanceof PaymentFlowError ? error.status : 500;
  return res.status(status).json({
    success: false,
    code: error.code || 'PAYMENT_VERIFICATION_FAILED',
    message: error instanceof PaymentFlowError ? error.message : fallbackMessage,
  });
};

const expectedPaise = (payment) => Math.round(Number(payment.amount) * 100);

/**
 * Bind a Checkout response to this authenticated user's immutable Payment row,
 * verify its signature using our order id, then confirm the gateway's own
 * amount/currency/order/status before anything is fulfilled.
 */
async function verifyOwnedCapturedPayment(req, orderType) {
  const webhookPayment = req.verifiedWebhookPayment;
  const {
    razorpay_order_id: bodyOrderId,
    razorpay_payment_id: bodyPaymentId,
    razorpay_signature: signature,
  } = req.body || {};
  const submittedOrderId = webhookPayment?.order_id || bodyOrderId;
  const paymentId = webhookPayment?.id || bodyPaymentId;

  if (!submittedOrderId || !paymentId || (!webhookPayment && !signature)) {
    throw new PaymentFlowError(400, 'Complete Razorpay payment details are required');
  }

  const payment = await Payment.findOne({
    razorpayOrderId: submittedOrderId,
    userId: req.user._id,
    orderType,
  });
  if (!payment) {
    throw new PaymentFlowError(404, 'Payment record not found');
  }
  if (payment.status === 'refunded'
      || ['processing', 'pending', 'processed'].includes(payment.metadata?.autoRefundStatus)) {
    throw new PaymentFlowError(409, 'This payment is being refunded and cannot be fulfilled');
  }

  if (payment.razorpayPaymentId
      && payment.razorpayPaymentId !== paymentId
      && payment.status !== 'failed') {
    throw new PaymentFlowError(409, 'This order is already linked to another payment');
  }

  let gatewayPayment;
  if (webhookPayment) {
    gatewayPayment = webhookPayment;
  } else {
    const signatureValid = razorpayService.verifySignature(
      payment.razorpayOrderId,
      paymentId,
      signature
    );
    if (!signatureValid) {
      throw new PaymentFlowError(400, 'Invalid payment signature');
    }

    try {
      gatewayPayment = await razorpayService.fetchPayment(paymentId);
      // Orders are configured for auto-capture. If the callback wins the race,
      // capture the authorised payment now so fulfilment never runs on a mere
      // authorisation. A concurrent auto-capture is harmless: refetch on error.
      if (gatewayPayment.status === 'authorized') {
        try {
          gatewayPayment = await razorpayService.capturePayment(
            paymentId,
            payment.amount,
            payment.currency
          );
        } catch (_) {
          gatewayPayment = await razorpayService.fetchPayment(paymentId);
        }
      }
    } catch (error) {
      throw new PaymentFlowError(502, 'Could not confirm the payment with Razorpay. Please retry.');
    }
  }

  if (gatewayPayment.order_id !== payment.razorpayOrderId) {
    throw new PaymentFlowError(400, 'Razorpay order does not match this payment');
  }
  if (Number(gatewayPayment.amount) !== expectedPaise(payment)) {
    throw new PaymentFlowError(409, 'Razorpay payment amount does not match the order');
  }
  if (String(gatewayPayment.currency || '').toUpperCase()
      !== String(payment.currency || '').toUpperCase()) {
    throw new PaymentFlowError(409, 'Razorpay payment currency does not match the order');
  }
  if (gatewayPayment.status !== 'captured') {
    throw new PaymentFlowError(
      409,
      'Payment is not captured yet. Please retry in a moment.',
      'PAYMENT_NOT_CAPTURED'
    );
  }

  payment.razorpayPaymentId = paymentId;
  if (signature) payment.razorpaySignature = signature;
  payment.status = 'captured';
  payment.method = gatewayPayment.method || payment.method;
  await payment.save();

  return payment;
}

const paymentMatchesEntity = (payment, entity) => (
  entity
  && entity.order_id === payment.razorpayOrderId
  && Number(entity.amount) === expectedPaise(payment)
  && String(entity.currency || '').toUpperCase() === String(payment.currency || '').toUpperCase()
);

async function markFulfilmentFailure(payment, kind, error) {
  if (!payment) return;
  payment.metadata = {
    ...(payment.metadata || {}),
    [`${kind}CreationFailed`]: true,
    [`${kind}CreationError`]: String(error?.message || error || 'Unknown fulfilment error'),
    failedAt: new Date().toISOString(),
  };
  payment.markModified('metadata');
  await payment.save();
}

/** Refund a captured payment when its order/booking could not be created. */
async function refundUnfulfilledPayment(payment, reason) {
  if (!payment?.razorpayPaymentId || payment.status !== 'captured') return null;

  const lock = await Payment.findOneAndUpdate(
    {
      _id: payment._id,
      status: 'captured',
      'metadata.autoRefundStatus': { $nin: ['processing', 'processed'] },
    },
    {
      $set: {
        'metadata.autoRefundStatus': 'processing',
        'metadata.autoRefundReason': String(reason || 'Fulfilment failed'),
        'metadata.autoRefundStartedAt': new Date().toISOString(),
      },
    },
    { new: true }
  );
  if (!lock) return null;

  let refund;
  try {
    refund = await razorpayService.refundPayment(lock.razorpayPaymentId);
    const processed = refund.status === 'processed';
    await Payment.findByIdAndUpdate(lock._id, {
      $set: {
        status: processed ? 'refunded' : 'captured',
        'metadata.autoRefundStatus': processed ? 'processed' : 'pending',
        'metadata.autoRefundId': refund.id,
        'metadata.autoRefundUpdatedAt': new Date().toISOString(),
      },
    });
    payment.status = processed ? 'refunded' : 'captured';
    return refund;
  } catch (error) {
    // If Razorpay returned an ID, keep this locked for webhook reconciliation.
    await Payment.findByIdAndUpdate(lock._id, {
      $set: refund?.id
        ? {
            'metadata.autoRefundStatus': 'pending',
            'metadata.autoRefundId': refund.id,
            'metadata.autoRefundError': error.message,
          }
        : {
            'metadata.autoRefundStatus': 'failed',
            'metadata.autoRefundError': error.message,
          },
    }).catch(() => {});
    throw error;
  }
}

// @desc    Create Razorpay order for product purchase
// @route   POST /api/payments/product/create
// @access  Private
exports.createProductOrderPayment = async (req, res) => {
  try {
    const { orderData } = req.body;

    console.log('💳 Creating product payment order for user:', req.user._id);

    // Validate order data
    if (!orderData || !orderData.items || orderData.items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Order data is required'
      });
    }
    if (orderData.items.length > 50
        || orderData.items.some((item) => !mongoose.isValidObjectId(item.productId)
          || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 100)) {
      return res.status(400).json({
        success: false,
        message: 'Cart contains an invalid item quantity'
      });
    }
    if (!mongoose.isValidObjectId(orderData.addressId)) {
      return res.status(400).json({ success: false, message: 'Select a valid delivery address' });
    }
    // The delivery fee is city-dependent, so the address must be read here, not
    // merely proven to exist.
    const deliveryAddress = await Address.findOne({ _id: orderData.addressId, userId: req.user._id });
    if (!deliveryAddress) {
      return res.status(400).json({ success: false, message: 'Select a valid delivery address' });
    }

    // Authoritative charge amount — computed from the database, never from the
    // client. The app used to send its own `amount`, so a tampered client could
    // pay ₹1 for a full-value cart. That field is now ignored entirely.
    const priced = await computeOrderPricing({
      items: orderData.items,
      couponCode: orderData.coupon?.code,
      city: deliveryAddress.city,
    });
    if (!priced.ok) {
      // Carries `code`/`minOrderValue` for BELOW_MIN_ORDER so the app can show
      // the shortfall instead of a generic failure.
      return res.status(priced.status || 400).json({
        success: false,
        message: priced.message,
        ...(priced.code ? { code: priced.code } : {}),
        ...(priced.minOrderValue !== undefined ? { minOrderValue: priced.minOrderValue } : {}),
      });
    }
    const chargeAmount = priced.pricing.total;
    if (!Number.isFinite(chargeAmount) || chargeAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Order total must be greater than zero' });
    }
    console.log('💰 Server-computed amount:', chargeAmount);

    // Generate receipt (max 40 chars for Razorpay)
    const timestamp = Date.now().toString().slice(-10);
    const userIdSuffix = req.user._id.toString().slice(-10);
    const receipt = `PROD_${timestamp}_${userIdSuffix}`;

    // Create Razorpay order
    const razorpayOrder = await razorpayService.createOrder(
      chargeAmount,
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
      amount: chargeAmount,
      currency: 'INR',
      status: 'created',
      metadata: {
        receipt: receipt,
        // Keep only the immutable fulfilment inputs. The verify request is not
        // allowed to replace these after the customer has paid.
        orderData: {
          items: orderData.items.map(({ productId, quantity }) => ({ productId, quantity })),
          addressId: orderData.addressId,
          coupon: priced.coupon || undefined,
          notes: orderData.notes || '',
        },
        pricingSnapshot: {
          pricing: priced.pricing,
          coupon: priced.coupon,
          items: priced.items.map(({ product, quantity }) => ({
            productId: product._id,
            productName: product.name,
            productImage: product.image,
            quantity,
            price: product.price,
            subtotal: product.price * quantity,
          })),
        },
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
      message: 'Failed to create payment order'
    });
  }
};

// @desc    Verify product payment and create order
// @route   POST /api/payments/product/verify
// @access  Private
exports.verifyProductPayment = async (req, res) => {
  let payment;
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    
    console.log('🔍 Verifying product payment:', razorpay_payment_id);
    
    payment = await verifyOwnedCapturedPayment(req, 'ProductOrder');
    const orderData = payment.metadata?.orderData;
    if (!orderData?.addressId || !Array.isArray(orderData.items)) {
      throw new PaymentFlowError(422, 'Stored order details are incomplete');
    }

    /*
     * Idempotency.
     *
     * Verify can arrive twice — a retried request, a double tap, a flaky
     * network. Without this guard the second call decremented stock a second
     * time and created a second ProductOrder against the same captured payment,
     * so the guest was charged once and inventory was double-counted. Mirrors
     * the consultation flow's guard.
     */
    const existingOrder = await ProductOrder.findOne({
      razorpayOrderId: payment.razorpayOrderId,
      userId: req.user._id,
    })
      .populate('userId', 'fullName email phone')
      .populate('items.productId');

    if (existingOrder) {
      console.log('↩️  Product order already exists for this payment:', existingOrder.orderNumber);
      return res.json({
        success: true,
        message: 'Payment already verified — your order is confirmed.',
        data: existingOrder
      });
    }

    console.log('✅ Payment verified and captured');

    // Create product order
    console.log('📦 Creating product order...');
    
    // Validate and get address
    const address = await Address.findOne({
      _id: orderData.addressId,
      userId: req.user._id
    });
    
    if (!address) {
      await markFulfilmentFailure(payment, 'order', 'Delivery address not found');
      await refundUnfulfilledPayment(payment, 'Delivery address was unavailable after payment').catch(() => {});
      return res.status(404).json({
        success: false,
        message: 'Your payment was received, but the address was unavailable. A full refund has been initiated.'
      });
    }
    
    // Honour the exact server-side snapshot the customer paid for. This also
    // prevents a price or coupon change during the Razorpay sheet from making
    // the captured amount diverge from the eventual order.
    let pricingSnapshot = payment.metadata?.pricingSnapshot;
    if (!pricingSnapshot?.items || !pricingSnapshot?.pricing) {
      // Compatibility for payment rows created by an older app/backend build.
      const priced = await computeOrderPricing({
        items: orderData.items,
        couponCode: orderData.coupon?.code,
        city: address.city,
      });
      if (!priced.ok) {
        await markFulfilmentFailure(payment, 'order', priced.message);
        await refundUnfulfilledPayment(payment, priced.message).catch(() => {});
        return res.status(422).json({
          success: false,
          message: 'Your payment was received, but the order could not be created. A full refund has been initiated.',
        });
      }
      pricingSnapshot = {
        pricing: priced.pricing,
        coupon: priced.coupon,
        items: priced.items.map(({ product, quantity }) => ({
          productId: product._id,
          productName: product.name,
          productImage: product.image,
          quantity,
          price: product.price,
          subtotal: product.price * quantity,
        })),
      };
    }
    if (Number(pricingSnapshot.pricing.total) !== Number(payment.amount)) {
      throw new PaymentFlowError(409, 'Stored order total does not match the captured payment');
    }
    const itemsToProcess = pricingSnapshot.items;

    // Second pass: atomically reduce stock
    const processedItems = [];
    for (const item of itemsToProcess) {
      const { productId, quantity } = item;
      // No count kept for this product (trackStock:false — Zenoti-mirrored):
      // confirm it is still on sale and move on without touching `stock`.
      const untracked = await Product.findOne({ _id: productId, trackStock: false }).select('_id isActive').lean();
      const updated = untracked
        ? (untracked.isActive ? untracked : null)
        : await Product.findOneAndUpdate(
        { 
          _id: productId,
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
            { $inc: { stock: processed.quantity } },
            // (no-op for untracked products: the filter below excludes them)
          );
        }

        await markFulfilmentFailure(
          payment,
          'order',
          `Stock changed for ${item.productName} after payment`
        );
        await refundUnfulfilledPayment(payment, `Stock changed for ${item.productName}`).catch(() => {});
        
        return res.status(400).json({
          success: false,
          message: `Stock changed for ${item.productName}. A full refund has been initiated.`,
          requiresRefresh: true
        });
      }

      processedItems.push({
        productId,
        productName: item.productName,
        productImage: item.productImage,
        quantity,
        price: item.price,
        subtotal: item.subtotal,
      });
    }
    
    // Generate order number
    const orderCount = await ProductOrder.countDocuments();
    const orderNumber = `ORD${Date.now()}${String(orderCount + 1).padStart(4, '0')}`;
    
    // Create product order
    let order;
    try {
      order = await ProductOrder.create({
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
      pricing: pricingSnapshot.pricing,
      coupon: pricingSnapshot.coupon || undefined,
      paymentMethod: 'Razorpay',
      paymentStatus: 'Paid',
      // Keep the Razorpay trail on the order so a refund or reconciliation can
      // start from either side, and so the idempotency guard above can find it.
      razorpayOrderId: razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id,
      razorpaySignature: razorpay_signature,
      notes: orderData.notes || ''
      });
    } catch (error) {
      for (const processed of processedItems) {
        await Product.updateOne({ _id: processed.productId, trackStock: { $ne: false } }, { $inc: { stock: processed.quantity } });
      }
      if (error?.code === 11000
          && (error?.keyPattern?.razorpayOrderId || error?.keyPattern?.razorpayPaymentId)) {
        const racedOrder = await ProductOrder.findOne({
          razorpayOrderId: payment.razorpayOrderId,
          userId: req.user._id,
        });
        if (racedOrder) {
          payment.orderId = racedOrder._id;
          await payment.save();
          return res.json({
            success: true,
            message: 'Payment already verified — your order is confirmed.',
            data: racedOrder,
          });
        }
      }
      throw error;
    }

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
    if (payment?.status === 'captured' && !payment.orderId) {
      await markFulfilmentFailure(payment, 'order', error).catch(() => {});
      await refundUnfulfilledPayment(payment, error.message).catch(() => {});
    }
    return paymentErrorResponse(res, error, 'Failed to verify payment');
  }
};

// @desc    Create Razorpay order for Zen membership
// @route   POST /api/payments/membership/create
// @access  Private
exports.createMembershipPayment = async (req, res) => {
  try {
    /*
     * The membership price is a clinic setting (App Studio → Membership).
     *
     * `priceInr` is the ONE authority for the charge. The card also carries
     * basePriceInr / salePriceInr, but those are presentation — a struck-through
     * "was" figure and the offer beside it. Charging from a second field is how
     * consultation pricing ended up living in four places that only agreed by
     * accident, so the amount is read from `priceInr` and nowhere else.
     */
    const AppCustomization = require('../models/AppCustomization');
    const settings = await AppCustomization.getSettings();
    const amount = Number(settings?.membership?.priceInr) > 0 ? Number(settings.membership.priceInr) : 110000;

    if (settings?.membership?.isActive === false) {
      return res.status(409).json({
        success: false,
        message: 'The membership is not on sale at the moment. Please speak to the clinic.',
      });
    }
    
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
    const timestamp = Date.now().toString().slice(-8);
    const receipt = `VIP_PKG_${timestamp}`;
    
    // Create Razorpay order
    const razorpayOrder = await razorpayService.createOrder(
      amount,
      'INR',
      receipt,
      {
        orderType: 'vip_wellness_package',
        userId: req.user._id.toString(),
        packageType: 'VIP Wellness Package',
        validity: '1 year'
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
        duration: '1 year'
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
      message: 'Failed to create membership payment'
    });
  }
};

// @desc    Verify membership payment and upgrade user
// @route   POST /api/payments/membership/verify
// @access  Private
exports.verifyMembershipPayment = async (req, res) => {
  try {
    const { razorpay_payment_id } = req.body;
    
    console.log('🔍 Verifying membership payment:', razorpay_payment_id);
    
    const payment = await verifyOwnedCapturedPayment(req, 'ZenMembership');
    
    console.log('✅ Membership payment verified');

    // Activate the membership. Idempotent: a retried verify won't reset the
    // dates, and the webhook runs this same path if this call never reaches us.
    const user = await activateMembership(req.user._id, payment);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

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
    return paymentErrorResponse(res, error, 'Failed to verify membership payment');
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
      return res.status(503).send('Webhook secret not configured');
    }

    // Razorpay signs the exact request bytes. A parsed/re-stringified object is
    // not equivalent and must never be accepted as a fallback.
    if (!Buffer.isBuffer(req.rawBody) || !signature) {
      return res.status(400).send('Missing raw webhook body or signature');
    }
    const isValid = razorpayService.verifyWebhookSignature(
      req.rawBody,
      signature,
      webhookSecret
    );
    
    if (!isValid) {
      console.error('❌ Invalid webhook signature');
      return res.status(400).send('Invalid signature');
    }
    
    const event = req.body?.event;
    const payload = req.body?.payload;
    if (!event || !payload) return res.status(400).send('Invalid webhook payload');
    
    console.log('📨 Webhook received:', event);
    
    // Handle different webhook events
    switch (event) {
      case 'payment.captured':
        if (!payload.payment?.entity) return res.status(400).send('Missing payment entity');
        await handlePaymentCaptured(payload.payment.entity);
        break;
      
      case 'payment.failed':
        if (!payload.payment?.entity) return res.status(400).send('Missing payment entity');
        await handlePaymentFailed(payload.payment.entity);
        break;

      case 'refund.processed':
        if (!payload.refund?.entity) return res.status(400).send('Missing refund entity');
        await handleRefundProcessed(payload.refund.entity);
        break;

      case 'refund.created':
        if (!payload.refund?.entity) return res.status(400).send('Missing refund entity');
        await handleRefundCreated(payload.refund.entity);
        break;

      case 'refund.failed':
        if (!payload.refund?.entity) return res.status(400).send('Missing refund entity');
        await handleRefundFailed(payload.refund.entity);
        break;
      
      case 'order.paid':
        if (payload.payment?.entity) {
          await handlePaymentCaptured(payload.payment.entity);
        } else {
          console.log('✅ Order paid event received');
        }
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
    
    /*
     * Look up by order id as well as payment id.
     *
     * Razorpay's webhook can land before the app's verify call has run, and
     * until then our record has no razorpayPaymentId — so a payment-id-only
     * lookup found nothing and the webhook silently did nothing, losing the
     * payment method along with it.
     */
    const payment = await Payment.findOne({
      $or: [
        { razorpayPaymentId: paymentEntity.id },
        { razorpayOrderId: paymentEntity.order_id },
      ],
    });

    if (payment) {
      if (!paymentMatchesEntity(payment, paymentEntity)) {
        throw new Error(`Gateway payment details do not match local payment ${payment._id}`);
      }
      if (payment.razorpayPaymentId
          && payment.razorpayPaymentId !== paymentEntity.id
          && payment.status !== 'failed') {
        throw new Error(`Gateway order ${payment.razorpayOrderId} is linked to another payment`);
      }

      if (payment.status !== 'refunded') payment.status = 'captured';
      payment.method = paymentEntity.method;
      payment.razorpayPaymentId = paymentEntity.id;
      await payment.save();
      console.log('💾 Payment status updated to captured, method:', paymentEntity.method);

      /*
       * Fallback: finish a membership purchase from the webhook.
       *
       * The app normally activates the membership in /membership/verify, but if
       * it's killed or loses network right after paying, that call never lands
       * and the guest is charged without becoming a member. The webhook is the
       * safety net — activateMembership is idempotent, so if verify already ran
       * this does nothing.
       *
       * Product and consultation fulfilment use the same idempotent controller
       * path as the app. This closes the "paid, then app closed" gap; unique
       * gateway indexes make a simultaneous app verification safe.
       */
      if (payment.orderType === 'ZenMembership' && payment.status === 'captured') {
        try {
          await activateMembership(payment.userId, payment);
        } catch (memErr) {
          console.error('❌ Webhook membership activation failed:', memErr.message);
          throw memErr;
        }
      } else if (payment.status === 'captured'
          && !['processing', 'pending', 'processed'].includes(payment.metadata?.autoRefundStatus)
          && !payment.orderId
          && ['ProductOrder', 'Booking'].includes(payment.orderType)) {
        await fulfilPaymentFromWebhook(payment, paymentEntity);
      }
    } else {
      console.warn('⚠️ Webhook capture for an unknown payment:', paymentEntity.id, paymentEntity.order_id);
    }
  } catch (error) {
    console.error('❌ Error handling payment captured:', error);
    throw error;
  }
}

async function fulfilPaymentFromWebhook(payment, paymentEntity) {
  let statusCode = 200;
  const response = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      if (statusCode >= 500) {
        throw new Error(`Webhook fulfilment failed with ${statusCode}: ${body?.message || 'unknown error'}`);
      }
      if (!body?.success) {
        console.warn(
          '⚠️ Webhook fulfilment did not complete:',
          payment.orderType,
          statusCode,
          body?.code || body?.message
        );
      }
      return body;
    },
  };
  const request = {
    user: { _id: payment.userId },
    body: {
      razorpay_order_id: paymentEntity.order_id,
      razorpay_payment_id: paymentEntity.id,
    },
    verifiedWebhookPayment: paymentEntity,
  };

  if (payment.orderType === 'ProductOrder') {
    await exports.verifyProductPayment(request, response);
  } else if (payment.orderType === 'Booking') {
    await exports.verifyConsultationPayment(request, response);
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
      // Webhook delivery order is not guaranteed. Never let a late failure
      // event overwrite a payment we have already captured or refunded.
      if (!['captured', 'refunded'].includes(payment.status)) payment.status = 'failed';
      payment.failureReason = paymentEntity.error_description || 'Payment failed';
      payment.metadata = {
        ...(payment.metadata || {}),
        lastFailedPaymentId: paymentEntity.id,
        lastFailedAt: new Date().toISOString(),
      };
      payment.markModified('metadata');
      await payment.save();
      console.log('💾 Payment status updated to failed');
    }
  } catch (error) {
    console.error('❌ Error handling payment failed:', error);
    throw error;
  }
}

async function handleRefundProcessed(refundEntity) {
  const payment = await Payment.findOne({
    razorpayPaymentId: refundEntity.payment_id,
    $or: [
      { 'metadata.autoRefundId': refundEntity.id },
      { 'metadata.autoRefundStatus': 'processing' },
      { 'metadata.autoRefundStatus': 'pending' },
    ],
  });
  if (payment) {
    payment.status = 'refunded';
    payment.metadata = {
      ...(payment.metadata || {}),
      autoRefundStatus: 'processed',
      autoRefundId: refundEntity.id,
      autoRefundUpdatedAt: new Date().toISOString(),
    };
    payment.markModified('metadata');
    await payment.save();
    return;
  }

  const orderMatch = [
    { 'refundDetails.razorpayRefundId': refundEntity.id },
    { 'refundDetails.status': 'Processing' },
  ];
  if (refundEntity.notes?.order_id && mongoose.isValidObjectId(refundEntity.notes.order_id)) {
    orderMatch.push({ _id: refundEntity.notes.order_id });
  }
  const order = await ProductOrder.findOne({
    razorpayPaymentId: refundEntity.payment_id,
    $or: orderMatch,
  });
  if (!order) {
    console.warn('⚠️ Processed refund for an unknown order:', refundEntity.id);
    return;
  }

  const wasCompleted = order.refundDetails?.status === 'Completed';
  order.refundDetails.status = 'Completed';
  order.refundDetails.razorpayRefundId = refundEntity.id;
  order.refundDetails.refundCompletedAt = new Date();
  order.refundDetails.transactionId = refundEntity.id;
  order.refundDetails.failureReason = undefined;
  if (Number(refundEntity.amount) >= Math.round(Number(order.pricing.total) * 100)) {
    order.paymentStatus = 'Refunded';
    await Payment.findOneAndUpdate(
      { razorpayPaymentId: refundEntity.payment_id },
      { status: 'refunded' }
    );
  }
  if (!wasCompleted) {
    order.statusHistory.push({
      status: 'Refund Completed',
      timestamp: new Date(),
      note: `Razorpay confirmed refund ${refundEntity.id}`,
    });
  }
  await order.save();

  const notificationClaim = await ProductOrder.updateOne(
    { _id: order._id, 'refundDetails.refundNotifiedAt': { $exists: false } },
    { $set: { 'refundDetails.refundNotifiedAt': new Date() } }
  );
  if (notificationClaim.modifiedCount === 1) {
    setImmediate(async () => {
      try {
        const populated = await ProductOrder.findById(order._id).populate('userId', 'fullName email phone');
        const user = populated?.userId;
        if (!user) return;
        const data = {
          customerName: populated.shippingAddress.fullName,
          orderNumber: populated.orderNumber,
          refundAmount: Number(refundEntity.amount) / 100,
          refundMethod: 'Razorpay',
          refundDate: new Date().toLocaleDateString('en-IN'),
          transactionId: refundEntity.id,
          estimatedDays: '5-7',
        };
        if (user.phone) await require('../services/whatsappService').sendRefundProcessed(user.phone, data);
        if (user.email) await require('../utils/emailService').sendRefundProcessedEmail(user.email, data.customerName, data);
      } catch (error) {
        console.error('Refund completion notification failed:', error.message);
      }
    });
  }
}

async function handleRefundCreated(refundEntity) {
  if (refundEntity.status === 'processed') return handleRefundProcessed(refundEntity);
  if (refundEntity.status === 'failed') return handleRefundFailed(refundEntity);

  const orderMatch = [
    { 'refundDetails.razorpayRefundId': refundEntity.id },
    { 'refundDetails.status': { $in: ['Processing', 'Failed'] } },
  ];
  if (refundEntity.notes?.order_id && mongoose.isValidObjectId(refundEntity.notes.order_id)) {
    orderMatch.push({ _id: refundEntity.notes.order_id });
  }
  await ProductOrder.findOneAndUpdate(
    { razorpayPaymentId: refundEntity.payment_id, $or: orderMatch },
    {
      $set: {
        'refundDetails.status': 'Processing',
        'refundDetails.razorpayRefundId': refundEntity.id,
        'refundDetails.transactionId': refundEntity.id,
        'refundDetails.failureReason': null,
      },
    }
  );
}

async function handleRefundFailed(refundEntity) {
  const payment = await Payment.findOne({
    razorpayPaymentId: refundEntity.payment_id,
    $or: [
      { 'metadata.autoRefundId': refundEntity.id },
      { 'metadata.autoRefundStatus': 'processing' },
      { 'metadata.autoRefundStatus': 'pending' },
    ],
  });
  if (payment) {
    if (payment.status === 'refunded' || payment.metadata?.autoRefundStatus === 'processed') return;
    payment.metadata = {
      ...(payment.metadata || {}),
      autoRefundStatus: 'failed',
      autoRefundId: refundEntity.id,
      autoRefundError: refundEntity.error_description || 'Razorpay refund failed',
      autoRefundUpdatedAt: new Date().toISOString(),
    };
    payment.markModified('metadata');
    await payment.save();
    return;
  }

  const orderMatch = [
    { 'refundDetails.razorpayRefundId': refundEntity.id },
    { 'refundDetails.status': 'Processing' },
  ];
  if (refundEntity.notes?.order_id && mongoose.isValidObjectId(refundEntity.notes.order_id)) {
    orderMatch.push({ _id: refundEntity.notes.order_id });
  }
  const order = await ProductOrder.findOne({
    razorpayPaymentId: refundEntity.payment_id,
    $or: orderMatch,
  });
  if (!order) {
    console.warn('⚠️ Failed refund for an unknown order:', refundEntity.id);
    return;
  }

  if (order.refundDetails?.status === 'Completed') return;
  if (order.refundDetails?.status === 'Failed'
      && order.refundDetails?.razorpayRefundId === refundEntity.id) return;

  order.refundDetails.status = 'Failed';
  order.refundDetails.razorpayRefundId = refundEntity.id;
  order.refundDetails.failureReason = refundEntity.error_description || 'Razorpay refund failed';
  order.statusHistory.push({
    status: 'Refund Failed',
    timestamp: new Date(),
    note: `Razorpay refund ${refundEntity.id} failed: ${order.refundDetails.failureReason}`,
  });
  await order.save();
}

/**
 * Activate (or re-affirm) a user's Zen membership from a captured payment.
 *
 * Idempotent by design so it can run from two places without double-applying:
 *   - the client's /membership/verify call (the normal path), and
 *   - the Razorpay webhook (the fallback, for when the app is killed or loses
 *     network after paying but before verify runs).
 *
 * The `membershipActivated` flag on the payment is the guard: once set, a repeat
 * call returns the user unchanged rather than resetting the start date or
 * pushing the expiry out by another year.
 *
 * @param {String|ObjectId} userId
 * @param {Object} payment - the Payment document (will be updated + saved)
 * @returns {Promise<Object|null>} the user, or null if not found
 */
async function activateMembership(userId, payment) {
  const user = await User.findById(userId);
  if (!user) return null;

  // Already applied for this payment — do not reset dates on a retry/webhook.
  if (payment?.metadata?.membershipActivated) {
    return user;
  }

  const AppCustomizationM = require('../models/AppCustomization');
  const months = Number((await AppCustomizationM.getSettings())?.membership?.durationMonths) || 12;
  const now = new Date();
  const stillActive = user.memberType === 'Zen Member' && user.zenMembershipExpiryDate && new Date(user.zenMembershipExpiryDate) > now;
  // Renewing early extends from the current expiry — the guest never loses paid time.
  const base = stillActive ? new Date(user.zenMembershipExpiryDate) : now;
  const expiry = new Date(base); expiry.setMonth(expiry.getMonth() + months);
  user.memberType = 'Zen Member';
  if (!stillActive) user.zenMembershipStartDate = now;
  user.zenMembershipExpiryDate = expiry;
  user.zenMembershipAutoRenew = false;
  user.zenMembershipSource = 'app';
  user.zenMembershipPlan = `Zen Membership · ${months} month${months === 1 ? '' : 's'}`;
  user.zenMembershipMonths = months;
  user.zenMembershipAmount = payment ? payment.amount : user.zenMembershipAmount;
  user.zenMembershipPaymentMethod = 'Razorpay';
  user.zenMembershipPaymentStatus = 'paid';
  user.zenMembershipPaymentId = payment ? payment._id : null;
  user.zenMembershipGrantedBy = null;
  await user.save({ validateModifiedOnly: true });

  if (payment) {
    payment.metadata = {
      ...(payment.metadata || {}),
      membershipActivated: true,
      membershipActivatedAt: new Date().toISOString()
    };
    payment.markModified('metadata');
    await payment.save();
  }

  console.log('👑 Zen membership activated for', user.email, '→', user.zenMembershipExpiryDate.toLocaleDateString());
  return user;
}

// @desc    Create Razorpay order for consultation booking
// @route   POST /api/payments/consultation/create
// @access  Private
exports.createConsultationPayment = async (req, res) => {
  try {
    const { consultationId, bookingData } = req.body;
    
    console.log('💳 Creating consultation payment order for user:', req.user._id);
    
    // Validate booking data
    if (!bookingData || !mongoose.isValidObjectId(consultationId)) {
      return res.status(400).json({
        success: false,
        message: 'Booking data and consultation ID are required'
      });
    }
    const preferredLocation = bookingData.preferredLocation || bookingData.location;
    const requestedTimes = bookingData.slotTime
      ? [bookingData.slotTime]
      : bookingData.preferredTimeSlots;
    if (!bookingData.fullName
        || !(bookingData.mobileNumber || bookingData.mobile)
        || !bookingData.email
        || !bookingData.preferredDate
        || !preferredLocation
        || !Array.isArray(requestedTimes)
        || requestedTimes.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Complete patient, clinic, date, and time details are required'
      });
    }
    
    // Fetch consultation to get price
    const Consultation = require('../models/Consultation');
    const consultation = await Consultation.findById(consultationId);
    
    if (!consultation) {
      return res.status(404).json({
        success: false,
        message: 'Consultation not found'
      });
    }

    // The clinic's backend-managed working days/hours are authoritative. Do
    // this before creating a Razorpay order so a stale client cannot pay for a
    // closed day or an old time range.
    const Branch = require('../models/Branch');
    let branch = preferredLocation
      ? await Branch.findOne({ name: preferredLocation, isActive: true })
      : null;
    if (!branch && preferredLocation) {
      const escaped = preferredLocation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      branch = await Branch.findOne({
        name: { $regex: escaped, $options: 'i' },
        isActive: true,
      });
    }

    if (!branch) {
      return res.status(404).json({
        success: false,
        code: 'BRANCH_NOT_AVAILABLE',
        message: 'The selected clinic is no longer available. Please choose another clinic.',
      });
    }

    const scheduleCheck = (bookingData.slotTime && bookingData.specialistId
      ? validateBranchSession
      : validateBranchBooking)(
      branch,
      bookingData.preferredDate,
      requestedTimes
    );
    if (!scheduleCheck.ok) {
      return res.status(409).json({
        success: false,
        code: scheduleCheck.code,
        message: scheduleCheck.message,
      });
    }

    // A time-first result carries the exact clinic where this dermatologist
    // is free. Re-check that pairing before opening Razorpay, rather than
    // capturing payment and discovering the mismatch during verification.
    if (bookingData.slotTime && bookingData.specialistId) {
      const { isSlotBookable } = require('../utils/dermatologistSlots');
      const key = clinicDateKey(bookingData.preferredDate);
      const check = key
        ? await isSlotBookable(bookingData.specialistId, key, bookingData.slotTime, {
            branchId: branch._id,
          })
        : { ok: false, reason: 'invalid-date' };
      if (!check.ok) {
        return res.status(409).json({
          success: false,
          code: 'DERMATOLOGIST_SLOT_UNAVAILABLE',
          message: 'This dermatologist is no longer available at that clinic and time. Please choose another option.',
        });
      }
    }
    
    /*
     * What to charge.
     *
     * This used to be `consultation.price` — the catalogue row. That made the
     * catalogue the authority on price, so an admin changing the fee in the
     * panel (or approving a doctor's higher rate) did not change what the guest
     * was actually charged. The resolver below asks, in order: this specialist's
     * approved rate, then the tier's standard fee, then the catalogue.
     */
    const { resolveConsultationAmount } = require('../utils/consultationPricing');
    const { amount, source } = await resolveConsultationAmount({
      consultation,
      specialistId: bookingData.specialistId,
      specialistTier: bookingData.specialistTier,
    });

    // Validate amount
    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'This consultation has no price set. Please contact the clinic.'
      });
    }

    console.log(`💰 Consultation amount ₹${amount} (resolved from: ${source})`);
    
    // Generate receipt (max 40 chars for Razorpay)
    const timestamp = Date.now().toString().slice(-10);
    const userIdSuffix = req.user._id.toString().slice(-10);
    const receipt = `CONS_${timestamp}_${userIdSuffix}`;
    
    // Create Razorpay order
    const razorpayOrder = await razorpayService.createOrder(
      amount,
      'INR',
      receipt,
      {
        orderType: 'consultation',
        userId: req.user._id.toString(),
        consultationId: consultationId,
        consultationName: consultation.name
      }
    );
    
    // Create payment record in database
    const payment = await Payment.create({
      userId: req.user._id,
      orderType: 'Booking',
      razorpayOrderId: razorpayOrder.id,
      amount: amount,
      currency: 'INR',
      status: 'created',
      metadata: {
        receipt: receipt,
        consultationId: consultationId,
        bookingData: {
          ...bookingData,
          consultationId,
          preferredLocation: branch.name,
          consultationFee: amount,
          totalAmount: amount,
        }
      }
    });
    
    console.log('✅ Consultation payment record created:', payment._id);
    
    res.json({
      success: true,
      data: {
        orderId: razorpayOrder.id,
        amount: razorpayOrder.amount,
        currency: razorpayOrder.currency,
        keyId: process.env.RAZORPAY_KEY_ID,
        paymentId: payment._id,
        consultationPrice: amount
      }
    });
  } catch (error) {
    console.error('❌ Create consultation payment error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create payment order'
    });
  }
};

// @desc    Verify consultation payment and create booking
// @route   POST /api/payments/consultation/verify
// @access  Private
exports.verifyConsultationPayment = async (req, res) => {
  let payment;
  try {
    const { razorpay_order_id, razorpay_payment_id } = req.body;
    
    console.log('🔍 Verifying consultation payment:', razorpay_payment_id);
    
    payment = await verifyOwnedCapturedPayment(req, 'Booking');
    const bookingData = payment.metadata?.bookingData;
    if (!bookingData?.consultationId) {
      throw new PaymentFlowError(422, 'Stored booking details are incomplete');
    }
    
    const Booking = require('../models/Booking');
    const Consultation = require('../models/Consultation');
    const Branch = require('../models/Branch');

    /*
     * Idempotency.
     *
     * Verify can arrive twice — a retried request, a double tap, a flaky
     * network. Without this check the second call created a second Booking
     * against the same captured payment, so the guest was charged once and had
     * two appointments.
     */
    const existing = await Booking.findOne({
      razorpayOrderId: payment.razorpayOrderId,
      userId: req.user._id,
    })
      .populate('consultationId', 'name category price image');

    if (existing) {
      console.log('↩️  Booking already exists for this order:', existing.referenceNumber);
      return res.json({
        success: true,
        message: 'Payment already verified — this booking is confirmed.',
        data: {
          booking: existing,
          payment: { id: payment._id, amount: payment.amount, status: payment.status },
        },
      });
    }

    console.log('✅ Payment verified and captured');

    // Older app builds send `location`/`mobile`; current ones send
    // `preferredLocation`/`mobileNumber`. Accept both.
    const preferredLocation = bookingData.preferredLocation || bookingData.location;
    const mobileNumber = bookingData.mobileNumber || bookingData.mobile;

    const consultation = await Consultation.findById(bookingData.consultationId);
    // Branch names vary between "Jubilee Hills" and "Zennara Jubilee Hills"
    // depending on where the app sourced the value — match tolerantly.
    let branch = preferredLocation
      ? await Branch.findOne({ name: preferredLocation, isActive: true })
      : null;
    if (!branch && preferredLocation) {
      const escaped = preferredLocation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      branch = await Branch.findOne({
        name: { $regex: escaped, $options: 'i' },
        isActive: true
      });
    }

    if (!consultation || !branch) {
      /*
       * The money is already captured at this point, so a bad lookup must not
       * end as a bare 404 with nothing on record — that is how a paid guest
       * ends up with no appointment and no trail for support to follow.
       * Flag it on the payment so it can be found and reconciled.
       */
      payment.metadata = {
        ...(payment.metadata || {}),
        bookingCreationFailed: true,
        bookingCreationError: !consultation
          ? `Consultation ${bookingData.consultationId} not found`
          : `Branch "${preferredLocation}" not found or inactive`,
        failedAt: new Date().toISOString(),
      };
      payment.markModified('metadata');
      await payment.save();

      await refundUnfulfilledPayment(payment, payment.metadata.bookingCreationError).catch(() => {});

      console.error('🚨 Paid but no booking — payment', payment._id, payment.metadata.bookingCreationError);

      return res.status(422).json({
        success: false,
        message:
          'Your payment went through, but we could not confirm the appointment automatically. '
          + 'A full refund has been initiated, and the clinic has been notified.',
        data: { paymentId: payment._id, reference: payment.razorpayOrderId },
      });
    }


    const requestedTimes = bookingData.slotTime
      ? [bookingData.slotTime]
      : bookingData.preferredTimeSlots;
    const scheduleCheck = (bookingData.slotTime && bookingData.specialistId
      ? validateBranchSession
      : validateBranchBooking)(
      branch,
      bookingData.preferredDate,
      requestedTimes
    );
    if (!scheduleCheck.ok) {
      payment.metadata = {
        ...(payment.metadata || {}),
        bookingCreationFailed: true,
        bookingCreationError: scheduleCheck.message,
        failedAt: new Date().toISOString(),
      };
      payment.markModified('metadata');
      await payment.save();

      await refundUnfulfilledPayment(payment, scheduleCheck.message).catch(() => {});

      return res.status(422).json({
        success: false,
        code: scheduleCheck.code,
        message:
          'Your payment went through, but the clinic schedule changed before confirmation. '
          + 'A full refund has been initiated, and the clinic will contact you if needed.',
        data: { paymentId: payment._id, reference: payment.razorpayOrderId },
      });
    }

    /*
     * The slot the patient picked, re-checked here rather than trusted.
     *
     * Between the time picker answering "10:30 is free" and this line, the
     * patient has been away in the Razorpay sheet — long enough for somebody
     * else to take the slot. `slotTime` is only set for dermatologist
     * consultations booked off a calendar; treatment bookings still carry
     * `preferredTimeSlots` and no hard slot, so they skip all of this.
     */
    const slotTime = bookingData.slotTime || null;
    if (slotTime && bookingData.specialistId) {
      const { isSlotBookable } = require('../utils/dermatologistSlots');
      const key = clinicDateKey(bookingData.preferredDate);
      const check = await isSlotBookable(bookingData.specialistId, key, slotTime, {
        branchId: branch._id,
      });

      if (!check.ok) {
        payment.metadata = {
          ...(payment.metadata || {}),
          slotLostAfterPayment: true,
          slotLostReason: check.reason,
          requestedSlot: `${key} ${slotTime}`,
          failedAt: new Date().toISOString(),
        };
        payment.markModified('metadata');
        await payment.save();

        await refundUnfulfilledPayment(payment, `Requested slot unavailable: ${check.reason}`).catch(() => {});

        console.error('🚨 Paid but slot gone —', payment._id, key, slotTime, check.reason);

        // Deliberately not silently rebooked onto another time: the patient
        // chose this one, and moving them without asking is worse than a call.
        return res.status(409).json({
          success: false,
          message:
            'Your payment went through, but that time was taken while you were paying. '
            + 'A full refund has been initiated. Please choose another time.',
          data: { paymentId: payment._id, reference: payment.razorpayOrderId, reason: check.reason },
        });
      }
    }

    // A dermatologist consultation books a real, verified slot straight off the
    // doctor's own calendar, so it is confirmed on the spot — the time the guest
    // sees IS the appointment. Treatments (no hard slotTime, up to 3 preferred
    // times) still go to the clinic to confirm one of them.
    const isDermatologistSlot = !!(slotTime && bookingData.specialistId);

    const booking = new Booking({
      userId: req.user._id,
      consultationId: bookingData.consultationId,
      fullName: bookingData.fullName,
      mobileNumber: mobileNumber,
      email: bookingData.email,
      branchId: branch._id,
      preferredLocation: branch.name,
      preferredDate: new Date(bookingData.preferredDate),
      // Keep both: the single reserved slot, and the older preferred-times
      // list so reception screens written against it still render.
      preferredTimeSlots: slotTime ? [slotTime] : bookingData.preferredTimeSlots,
      slotTime,
      specialistId: bookingData.specialistId,
      specialistName: bookingData.specialistName,
      specialistTier: bookingData.specialistTier,
      /*
       * Always "Awaiting Confirmation", even for a paid dermatologist slot.
       *
       * This used to create a dermatologist-slot booking already Confirmed,
       * which (now that confirmation is what creates the Zenoti appointment)
       * would have put it in Zenoti the moment the customer paid. The clinic's
       * rule is that the desk approves every appointment first. The exact slot
       * is still held in the diary (slotHeld covers Awaiting), so nobody else
       * can take it while the desk confirms; confirmedDate/Time are set by the
       * panel's Confirm button.
       */
      status: 'Awaiting Confirmation',
      paymentId: payment._id,
      razorpayOrderId: razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id,
      paymentStatus: 'paid',
      amount: payment.amount,
      paymentMethod: 'Razorpay',
      paidAt: new Date()
    });

    try {
      await booking.save();
    } catch (err) {
      /*
       * The unique index is the real guard — two verifications racing both
       * pass the check above and only one can insert. E11000 here means we
       * lost that race.
       */
      if (err?.code === 11000
          && (err?.keyPattern?.razorpayOrderId || err?.keyPattern?.razorpayPaymentId)) {
        const racedBooking = await Booking.findOne({
          razorpayOrderId: payment.razorpayOrderId,
          userId: req.user._id,
        }).populate('consultationId', 'name category price image');
        if (racedBooking) {
          payment.orderId = racedBooking._id;
          await payment.save();
          return res.json({
            success: true,
            message: 'Payment already verified — this booking is confirmed.',
            data: {
              booking: racedBooking,
              payment: { id: payment._id, amount: payment.amount, status: payment.status },
            },
          });
        }
      }
      if (err?.code === 11000) {
        payment.metadata = {
          ...(payment.metadata || {}),
          slotLostAfterPayment: true,
          slotLostReason: 'race',
          requestedSlot: `${bookingData.preferredDate} ${slotTime}`,
          failedAt: new Date().toISOString(),
        };
        payment.markModified('metadata');
        await payment.save();

        await refundUnfulfilledPayment(payment, 'The requested slot was taken during payment').catch(() => {});

        console.error('🚨 Slot race lost —', payment._id, slotTime);

        return res.status(409).json({
          success: false,
          message:
            'Your payment went through, but that time was taken while you were paying. '
            + 'A full refund has been initiated. Please choose another time.',
          data: { paymentId: payment._id, reference: payment.razorpayOrderId, reason: 'race' },
        });
      }
      throw err;
    }
    // Link the payment back to the booking. Booking.paymentId already pointed
    // at the payment, but not the other way round, so a refund or a
    // reconciliation starting from a Payment had no way to reach the booking.
    payment.orderId = booking._id;
    await payment.save();

    await booking.populate('consultationId', 'name category price image');

    console.log('✅ Booking created with payment:', booking.referenceNumber);
    
    // Create notification — a dermatologist slot is already confirmed, so it
    // gets the "Appointment Confirmed" notification; a treatment (awaiting the
    // clinic) gets "Booking Request Received".
    const NotificationHelper = require('../utils/notificationHelper');
    try {
      const notifData = {
        _id: booking._id,
        userId: booking.userId,
        patientName: booking.fullName,
        consultation: { name: consultation.name },
        branch: { name: branch.name },
        appointmentDate: booking.preferredDate
      };
      if (isDermatologistSlot) {
        await NotificationHelper.bookingConfirmed({
          ...notifData,
          confirmedDate: booking.confirmedDate,
          confirmedTime: booking.confirmedTime
        });
      } else {
        await NotificationHelper.bookingCreated(notifData);
      }
    } catch (notifError) {
      console.error('⚠️ Failed to create notification:', notifError.message);
    }
    
    // External messages must not delay the payment response/webhook ACK. The
    // durable booking already exists, so send them after the response path.
    setImmediate(async () => {
      const emailService = require('../utils/emailService');
      try {
        if (isDermatologistSlot) {
          await emailService.sendAppointmentConfirmed(
            booking.email,
            booking.fullName,
            {
              referenceNumber: booking.referenceNumber,
              treatment: consultation.name,
              confirmedDate: booking.confirmedDate.toLocaleDateString('en-US', {
                weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
              }),
              confirmedTime: booking.confirmedTime,
              location: booking.preferredLocation
            },
            booking.preferredLocation
          );
        } else {
          await emailService.sendAppointmentBookingConfirmation(
            booking.email,
            booking.fullName,
            {
              referenceNumber: booking.referenceNumber,
              treatment: consultation.name,
              category: consultation.category,
              preferredDate: booking.preferredDate.toLocaleDateString('en-US', {
                weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
              }),
              timeSlots: booking.preferredTimeSlots.join(', '),
              location: booking.preferredLocation
            },
            booking.preferredLocation
          );
        }
      } catch (error) {
        console.error('⚠️ Email sending failed:', error.message);
      }

      try {
        await require('../services/whatsappService').sendBookingConfirmation(
          booking.mobileNumber,
          {
            patientName: booking.fullName,
            referenceNumber: booking.referenceNumber,
            treatment: consultation.name,
            date: booking.preferredDate.toLocaleDateString('en-US', {
              weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
            }),
            timeSlots: booking.preferredTimeSlots.join(', '),
            location: booking.preferredLocation
          }
        );
      } catch (error) {
        console.error('⚠️ WhatsApp sending failed:', error.message);
      }

      try {
        await require('../services/twilioVoiceService').makeBookingConfirmationCall(
          booking.mobileNumber,
          {
            patientName: booking.fullName,
            referenceNumber: booking.referenceNumber,
            treatment: consultation.name,
            date: booking.preferredDate.toLocaleDateString('en-US', {
              weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
            }),
            timeSlots: booking.preferredTimeSlots.join(', '),
            branchName: branch.name,
            branchAddress: `${branch.address.line1}, ${branch.address.city}`
          }
        );
      } catch (error) {
        console.error('⚠️ Voice call failed:', error.message);
      }
    });
    
    res.json({
      success: true,
      message: 'Payment verified and booking created successfully',
      data: {
        booking: booking,
        payment: {
          id: payment._id,
          amount: payment.amount,
          status: payment.status
        }
      }
    });
  } catch (error) {
    console.error('❌ Verify consultation payment error:', error);
    if (payment?.status === 'captured' && !payment.orderId) {
      const existingBooking = await require('../models/Booking').findOne({
        razorpayOrderId: payment.razorpayOrderId,
        userId: payment.userId,
      }).catch(() => null);
      if (!existingBooking) {
        await markFulfilmentFailure(payment, 'booking', error).catch(() => {});
        await refundUnfulfilledPayment(payment, error.message).catch(() => {});
      }
    }
    return paymentErrorResponse(res, error, 'Payment verification failed');
  }
};

module.exports = exports;
