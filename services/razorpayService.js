const Razorpay = require('razorpay');
const crypto = require('crypto');
const axios = require('axios');

let razorpay;

const getRazorpay = () => {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    throw new Error('Razorpay is not configured');
  }

  if (!razorpay) {
    razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
  }
  return razorpay;
};

const toPaise = (amount) => {
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error('Payment amount must be a positive number');
  }
  return Math.round(numericAmount * 100);
};

const safeHexEqual = (expected, supplied) => {
  if (typeof expected !== 'string' || typeof supplied !== 'string') return false;
  if (!/^[a-f0-9]+$/i.test(expected) || !/^[a-f0-9]+$/i.test(supplied)) return false;

  const expectedBuffer = Buffer.from(expected, 'hex');
  const suppliedBuffer = Buffer.from(supplied, 'hex');
  return expectedBuffer.length === suppliedBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
};

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
    if (!receipt || typeof receipt !== 'string' || receipt.length > 40) {
      throw new Error('A Razorpay receipt of at most 40 characters is required');
    }

    const options = {
      amount: toPaise(amount),
      currency: String(currency || 'INR').toUpperCase(),
      receipt,
      notes,
      payment_capture: 1 // Auto capture payment
    };

    console.log('📝 Creating Razorpay order:', receipt, options.amount, options.currency);
    const order = await getRazorpay().orders.create(options);
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
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keySecret || !orderId || !paymentId || !signature) return false;

    const text = `${orderId}|${paymentId}`;
    const generated = crypto
      .createHmac('sha256', keySecret)
      .update(text)
      .digest('hex');

    const isValid = safeHexEqual(generated, signature);
    
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
    if (!paymentId) throw new Error('Payment ID is required');
    const payment = await getRazorpay().payments.fetch(paymentId);
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
    const amountInPaise = toPaise(amount);
    const payment = await getRazorpay().payments.capture(
      paymentId,
      amountInPaise,
      String(currency || 'INR').toUpperCase()
    );
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
exports.refundPayment = async (paymentId, amount = null, options = {}) => {
  try {
    if (!paymentId) throw new Error('Payment ID is required');
    const payload = {};
    if (amount !== null && amount !== undefined) {
      payload.amount = toPaise(amount);
    }

    if (options.notes && typeof options.notes === 'object') payload.notes = options.notes;
    if (options.receipt) payload.receipt = String(options.receipt).slice(0, 40);

    let refund;
    if (options.idempotencyKey) {
      getRazorpay(); // Validate credentials before making the direct idempotent request.
      const idempotencyKey = String(options.idempotencyKey);
      if (!/^[A-Za-z0-9_-]{10,}$/.test(idempotencyKey)) {
        throw new Error('Refund idempotency key is invalid');
      }

      const response = await axios.post(
        `https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}/refund`,
        payload,
        {
          auth: {
            username: process.env.RAZORPAY_KEY_ID,
            password: process.env.RAZORPAY_KEY_SECRET,
          },
          headers: {
            'Content-Type': 'application/json',
            'X-Refund-Idempotency': idempotencyKey,
          },
          timeout: 20000,
        }
      );
      refund = response.data;
    } else {
      refund = await getRazorpay().payments.refund(paymentId, payload);
    }
    console.log('✅ Payment refunded:', paymentId);
    return refund;
  } catch (error) {
    console.error('❌ Error refunding payment:', error);
    const detail = error.response?.data?.error?.description
      || error.error?.description
      || error.message;
    throw new Error(`Failed to refund payment: ${detail}`);
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
    if (!Buffer.isBuffer(body) || !signature || !secret) return false;
    const generated = crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('hex');
    
    return safeHexEqual(generated, signature);
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
    if (!orderId) throw new Error('Order ID is required');
    const order = await getRazorpay().orders.fetch(orderId);
    return order;
  } catch (error) {
    console.error('❌ Error fetching order:', error);
    throw new Error(`Failed to fetch order: ${error.message}`);
  }
};

module.exports = exports;
