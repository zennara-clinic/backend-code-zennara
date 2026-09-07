const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const ProductOrder = require('../models/ProductOrder');
const Payment = require('../models/Payment');
const razorpayService = require('../services/razorpayService');
const { initiateOnlineRefund } = require('../services/orderLifecycleService');

test('product orders support failed delivery and a separate return-request state', () => {
  const statuses = ProductOrder.schema.path('orderStatus').enumValues;
  assert.ok(statuses.includes('Delivery Failed'));
  assert.ok(statuses.includes('Return Requested'));
  assert.ok(ProductOrder.schema.path('deliveryFailures'));
  assert.ok(ProductOrder.schema.path('stockRestoredAt'));
  assert.ok(ProductOrder.schema.path('refundDetails.idempotencyKey'));
});

test('Razorpay refunds send paise and the official idempotency header', async (t) => {
  const originalPost = axios.post;
  const originalKey = process.env.RAZORPAY_KEY_ID;
  const originalSecret = process.env.RAZORPAY_KEY_SECRET;
  process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
  process.env.RAZORPAY_KEY_SECRET = 'rzp_test_secret';

  let request;
  axios.post = async (...args) => {
    request = args;
    return { data: { id: 'rfnd_1', status: 'pending' } };
  };
  t.after(() => {
    axios.post = originalPost;
    if (originalKey === undefined) delete process.env.RAZORPAY_KEY_ID;
    else process.env.RAZORPAY_KEY_ID = originalKey;
    if (originalSecret === undefined) delete process.env.RAZORPAY_KEY_SECRET;
    else process.env.RAZORPAY_KEY_SECRET = originalSecret;
  });

  const result = await razorpayService.refundPayment('pay_123', 125.5, {
    idempotencyKey: 'order_123_refund_12550',
    receipt: 'r_order_123_12550',
    notes: { order_id: '123' },
  });

  assert.equal(result.id, 'rfnd_1');
  assert.equal(request[0], 'https://api.razorpay.com/v1/payments/pay_123/refund');
  assert.equal(request[1].amount, 12550);
  assert.equal(request[2].headers['X-Refund-Idempotency'], 'order_123_refund_12550');
});

test('a failed refund retry reuses the original amount, key, trigger and notes', async (t) => {
  const originals = {
    findById: ProductOrder.findById,
    findOneAndUpdate: ProductOrder.findOneAndUpdate,
    paymentUpdate: Payment.findOneAndUpdate,
    refundPayment: razorpayService.refundPayment,
  };
  t.after(() => {
    ProductOrder.findById = originals.findById;
    ProductOrder.findOneAndUpdate = originals.findOneAndUpdate;
    Payment.findOneAndUpdate = originals.paymentUpdate;
    razorpayService.refundPayment = originals.refundPayment;
  });

  const order = {
    _id: '66a111111111111111111111',
    orderNumber: 'ORD100',
    pricing: { total: 500 },
    paymentMethod: 'Razorpay',
    paymentStatus: 'Paid',
    razorpayPaymentId: 'pay_retry',
    refundDetails: {
      status: 'Failed',
      amount: 500,
      idempotencyKey: 'order_retry_key_50000',
      trigger: 'customer_cancellation',
      notes: 'Original cancellation refund',
    },
  };
  const locked = { ...order, refundDetails: { ...order.refundDetails, status: 'Processing' } };
  const updated = { ...locked, paymentStatus: 'Refunded', refundDetails: { ...locked.refundDetails, status: 'Completed' } };
  let updateCount = 0;
  ProductOrder.findById = async () => order;
  ProductOrder.findOneAndUpdate = async () => (++updateCount === 1 ? locked : updated);
  Payment.findOneAndUpdate = async () => ({});

  let refundCall;
  razorpayService.refundPayment = async (...args) => {
    refundCall = args;
    return { id: 'rfnd_retry', status: 'processed' };
  };

  const result = await initiateOnlineRefund(order._id, {
    amount: 500,
    trigger: 'manual',
    notes: 'A different retry note must not alter the gateway request',
  });

  assert.equal(result.completed, true);
  assert.equal(refundCall[1], 500);
  assert.equal(refundCall[2].idempotencyKey, 'order_retry_key_50000');
  assert.equal(refundCall[2].notes.trigger, 'customer_cancellation');
});

test('a retry cannot change the original refund amount', async (t) => {
  const original = ProductOrder.findById;
  t.after(() => { ProductOrder.findById = original; });
  ProductOrder.findById = async () => ({
    _id: '66a111111111111111111111',
    pricing: { total: 500 },
    paymentMethod: 'Razorpay',
    paymentStatus: 'Paid',
    razorpayPaymentId: 'pay_retry',
    refundDetails: { status: 'Failed', amount: 500, idempotencyKey: 'order_retry_key_50000' },
  });

  await assert.rejects(
    () => initiateOnlineRefund('66a111111111111111111111', { amount: 400 }),
    /same refund amount/
  );
});

test('a part refund leaves the balance refundable, and the total never exceeds what was paid', async (t) => {
  const originals = {
    findById: ProductOrder.findById,
    findOneAndUpdate: ProductOrder.findOneAndUpdate,
    paymentUpdate: Payment.findOneAndUpdate,
    refundPayment: razorpayService.refundPayment,
  };
  t.after(() => {
    ProductOrder.findById = originals.findById;
    ProductOrder.findOneAndUpdate = originals.findOneAndUpdate;
    Payment.findOneAndUpdate = originals.paymentUpdate;
    razorpayService.refundPayment = originals.refundPayment;
  });

  // Rs.400 of a Rs.1000 order has already been returned and settled.
  const order = {
    _id: '66a222222222222222222222',
    orderNumber: 'ORD200',
    pricing: { total: 1000 },
    paymentMethod: 'Razorpay',
    paymentStatus: 'Partially Refunded',
    razorpayPaymentId: 'pay_partial',
    refundDetails: {
      status: 'Completed',
      amount: 400,
      amountRefunded: 400,
      idempotencyKey: 'order_66a222222222222222222222_refund_40000',
    },
  };
  let writes = [];
  ProductOrder.findById = async () => order;
  ProductOrder.findOneAndUpdate = async (_filter, update) => {
    writes.push(update);
    return writes.length === 1
      ? { ...order, refundDetails: { ...order.refundDetails, status: 'Processing', amount: 600 } }
      : { ...order };
  };
  Payment.findOneAndUpdate = async () => ({});
  let refundCall;
  razorpayService.refundPayment = async (...args) => { refundCall = args; return { id: 'rfnd_2', status: 'processed' }; };

  // The balance defaults to what is still owed, and gets its own gateway key.
  const result = await initiateOnlineRefund(order._id, { trigger: 'manual' });
  assert.equal(result.completed, true);
  assert.equal(refundCall[1], 600, 'refunds the Rs.600 balance, not the Rs.1000 total');
  assert.notEqual(
    refundCall[2].idempotencyKey,
    order.refundDetails.idempotencyKey,
    'a second part refund must not reuse the settled refund key, or the gateway would treat it as a duplicate',
  );
  const completion = writes[1];
  assert.equal(completion.$inc['refundDetails.amountRefunded'], 600, 'the running total is incremented, not overwritten');
  assert.equal(completion.$set.paymentStatus, 'Refunded', 'Rs.400 + Rs.600 settles the order in full');

  // Asking for more than the balance is refused outright.
  await assert.rejects(
    () => initiateOnlineRefund(order._id, { amount: 700 }),
    /still refundable/,
    'must not refund more than the guest paid',
  );
});

test('a payment that Razorpay never took cannot report an automatic refund', async (t) => {
  const original = ProductOrder.findById;
  t.after(() => { ProductOrder.findById = original; });
  ProductOrder.findById = async () => ({
    _id: '66a333333333333333333333',
    pricing: { total: 250 },
    paymentMethod: 'Clinic',
    paymentStatus: 'Paid',
    refundDetails: {},
  });

  const result = await initiateOnlineRefund('66a333333333333333333333', { amount: 250 });
  assert.equal(result.manual, true);
  assert.equal(result.required, true);
  assert.match(result.reason, /cannot be refunded automatically/);
});
