const Razorpay = require('razorpay');
const crypto = require('crypto');

// Initialize Razorpay instance
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

/**
 * Create a Razorpay order
 * @param {Number} amount - Amount in rupees (will be converted to paise)
 * @param {String} currency - Currency code (default: INR)
 * @param {String} receipt - Receipt ID for reference
 * @param {Object} notes - Additional notes/metadata
 * @returns {Promise<Object>} Razorpay order object
 */
exports.createOrder = async (amount, currency = 'INR', receipt, notes = {}) => {
  try {
    const options = {
      amount: Math.round(amount * 100), // Convert rupees to paise
      currency,
      receipt,
      notes,
      payment_capture: 1 // Auto capture payment
    };

    console.log('📝 Creating Razorpay order:', options);
    const order = await razorpay.orders.create(options);
    console.log('✅ Razorpay order created:', order.id);
    
    return order;
  } catch (error) {
    console.error('❌ Error creating Razorpay order:', error);
    throw new Error(`Failed to create Razorpay order: ${error.message}`);
  }
};

/**
 * Verify Razorpay payment signature
 * @param {String} orderId - Razorpay order ID
 * @param {String} paymentId - Razorpay payment ID
 * @param {String} signature - Signature to verify
 * @returns {Boolean} True if signature is valid
 */
exports.verifySignature = (orderId, paymentId, signature) => {
  try {
    const text = `${orderId}|${paymentId}`;
    const generated = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(text)
      .digest('hex');

    const isValid = generated === signature;
    
    if (isValid) {
      console.log('✅ Payment signature verified successfully');
    } else {
      console.log('❌ Payment signature verification failed');
    }
    
    return isValid;
  } catch (error) {
    console.error('❌ Error verifying signature:', error);
    return false;
  }
};

/**
 * Fetch payment details from Razorpay
 * @param {String} paymentId - Razorpay payment ID
 * @returns {Promise<Object>} Payment details
 */
exports.fetchPayment = async (paymentId) => {
  try {
    const payment = await razorpay.payments.fetch(paymentId);
    return payment;
  } catch (error) {
    console.error('❌ Error fetching payment:', error);
    throw new Error(`Failed to fetch payment: ${error.message}`);
  }
};

/**
 * Capture payment (if not auto-captured)
 * @param {String} paymentId - Razorpay payment ID
 * @param {Number} amount - Amount to capture in rupees
 * @param {String} currency - Currency code
 * @returns {Promise<Object>} Captured payment object
 */
exports.capturePayment = async (paymentId, amount, currency = 'INR') => {
  try {
    const amountInPaise = Math.round(amount * 100);
    const payment = await razorpay.payments.capture(paymentId, amountInPaise, currency);
    console.log('✅ Payment captured:', paymentId);
    return payment;
  } catch (error) {
    console.error('❌ Error capturing payment:', error);
    throw new Error(`Failed to capture payment: ${error.message}`);
  }
};

/**
 * Refund payment
 * @param {String} paymentId - Razorpay payment ID
 * @param {Number} amount - Amount to refund in rupees (null for full refund)
 * @returns {Promise<Object>} Refund object
 */
exports.refundPayment = async (paymentId, amount = null) => {
  try {
    const options = {};
    if (amount) {
      options.amount = Math.round(amount * 100); // Convert to paise
    }
    
    const refund = await razorpay.payments.refund(paymentId, options);
    console.log('✅ Payment refunded:', paymentId);
    return refund;
  } catch (error) {
    console.error('❌ Error refunding payment:', error);
    throw new Error(`Failed to refund payment: ${error.message}`);
  }
};

/**
 * Verify webhook signature
 * @param {String} body - Raw request body as string
 * @param {String} signature - X-Razorpay-Signature header
 * @param {String} secret - Webhook secret
 * @returns {Boolean} True if signature is valid
 */
exports.verifyWebhookSignature = (body, signature, secret) => {
  try {
    const generated = crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('hex');
    
    return generated === signature;
  } catch (error) {
    console.error('❌ Error verifying webhook signature:', error);
    return false;
  }
};

/**
 * Fetch order details from Razorpay
 * @param {String} orderId - Razorpay order ID
 * @returns {Promise<Object>} Order details
 */
exports.fetchOrder = async (orderId) => {
  try {
    const order = await razorpay.orders.fetch(orderId);
    return order;
  } catch (error) {
    console.error('❌ Error fetching order:', error);
    throw new Error(`Failed to fetch order: ${error.message}`);
  }
};

module.exports = exports;
