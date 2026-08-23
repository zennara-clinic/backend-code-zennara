const mongoose = require('mongoose');
const ProductOrder = require('../models/ProductOrder');
const Product = require('../models/Product');
const Payment = require('../models/Payment');
const razorpayService = require('./razorpayService');

const ONLINE_METHODS = new Set(['Razorpay', 'Online']);

const asId = (value) => value?._id || value || null;

const refundKeyFor = (order, amount) => {
  const paise = Math.round(Number(amount) * 100);
  return `order_${String(order._id)}_refund_${paise}`;
};

/**
 * Put reserved product quantities back exactly once.
 *
 * The order flag and every Product increment are committed in one MongoDB
 * transaction. A retry therefore sees stockRestoredAt and cannot add stock a
 * second time, while a failed transaction leaves both the order and products
 * untouched.
 */
async function restoreStockOnce(orderId, reason) {
  const existing = await ProductOrder.findById(orderId).select('stockRestoredAt');
  if (!existing) throw new Error('Order not found');
  if (existing.stockRestoredAt) return { restored: false, alreadyRestored: true };

  const session = await mongoose.startSession();
  let restored = false;
  try {
    await session.withTransaction(async () => {
      const order = await ProductOrder.findOne({
        _id: orderId,
        stockRestoredAt: { $exists: false },
      }).session(session);

      if (!order) return;

      const operations = order.items.map((item) => ({
        updateOne: {
          filter: { _id: asId(item.productId) },
          update: { $inc: { stock: Number(item.quantity) } },
        },
      }));

      if (operations.length) {
        await Product.bulkWrite(operations, { session });
      }

      order.stockRestoredAt = new Date();
      order.stockRestorationReason = reason;
      await order.save({ session });
      restored = true;
    });
  } finally {
    await session.endSession();
  }

  return { restored, alreadyRestored: !restored };
}

/**
 * Start or resume an online refund. The stable Razorpay idempotency key makes
 * retries safe even if the first HTTP response was lost after Razorpay accepted
 * the request. Processing is finalised only by a processed API response or the
 * signed refund webhook.
 */
async function initiateOnlineRefund(orderId, options = {}) {
  const order = await ProductOrder.findById(orderId);
  if (!order) throw new Error('Order not found');

  const requestedAmount = options.amount == null ? Number(order.pricing.total) : Number(options.amount);
  const amount = order.refundDetails?.idempotencyKey && Number(order.refundDetails.amount) > 0
    ? Number(order.refundDetails.amount)
    : requestedAmount;
  if (order.refundDetails?.idempotencyKey && Math.round(requestedAmount * 100) !== Math.round(amount * 100)) {
    throw new Error('A retry must use the same refund amount as the original request');
  }
  if (!Number.isFinite(amount) || amount <= 0 || amount > Number(order.pricing.total)) {
    throw new Error('Invalid refund amount');
  }

  if (!ONLINE_METHODS.has(order.paymentMethod)) {
    return { order, required: order.paymentMethod === 'COD' && order.paymentStatus === 'Paid', manual: true };
  }
  if (order.paymentStatus !== 'Paid' && order.paymentStatus !== 'Refunded') {
    return { order, required: false, skipped: true };
  }
  if (!order.razorpayPaymentId) {
    throw new Error('Paid online order has no Razorpay payment ID');
  }

  if (order.paymentStatus === 'Refunded' || order.refundDetails?.status === 'Completed') {
    return { order, required: true, alreadyCompleted: true };
  }
  if (order.refundDetails?.status === 'Processing') {
    return { order, required: true, alreadyProcessing: true };
  }

  const idempotencyKey = order.refundDetails?.idempotencyKey || refundKeyFor(order, amount);
  const now = new Date();
  const actorId = asId(options.actorId);
  const trigger = order.refundDetails?.idempotencyKey
    ? (order.refundDetails.trigger || 'manual')
    : (options.trigger || 'manual');
  const refundNotes = order.refundDetails?.idempotencyKey
    ? (order.refundDetails.notes || 'Refund initiated to the original payment method')
    : (options.notes || 'Refund initiated to the original payment method');

  const locked = await ProductOrder.findOneAndUpdate(
    {
      _id: order._id,
      paymentStatus: { $ne: 'Refunded' },
      'refundDetails.status': { $nin: ['Processing', 'Completed'] },
    },
    {
      $set: {
        'refundDetails.method': 'Razorpay',
        'refundDetails.amount': amount,
        'refundDetails.status': 'Processing',
        'refundDetails.refundInitiatedAt': now,
        'refundDetails.refundedBy': actorId,
        'refundDetails.notes': refundNotes,
        'refundDetails.failureReason': null,
        'refundDetails.idempotencyKey': idempotencyKey,
        'refundDetails.trigger': trigger,
        'refundDetails.lastRetryAt': now,
      },
      $inc: { 'refundDetails.retryCount': 1 },
    },
    { new: true }
  );

  if (!locked) {
    const current = await ProductOrder.findById(order._id);
    return {
      order: current,
      required: true,
      alreadyProcessing: current?.refundDetails?.status === 'Processing',
      alreadyCompleted: current?.refundDetails?.status === 'Completed',
    };
  }

  try {
    const refund = await razorpayService.refundPayment(
      locked.razorpayPaymentId,
      amount,
      {
        idempotencyKey,
        receipt: `r_${locked.orderNumber}_${Math.round(amount * 100)}`.slice(0, 40),
        notes: {
          order_id: String(locked._id),
          order_number: String(locked.orderNumber),
          trigger: String(trigger),
        },
      }
    );

    const completed = refund.status === 'processed';
    const failed = refund.status === 'failed';
    const updated = await ProductOrder.findByIdAndUpdate(
      locked._id,
      {
        $set: {
          'refundDetails.status': completed ? 'Completed' : failed ? 'Failed' : 'Processing',
          'refundDetails.razorpayRefundId': refund.id,
          'refundDetails.transactionId': refund.id,
          'refundDetails.refundCompletedAt': completed ? new Date() : null,
          'refundDetails.failureReason': failed ? 'Razorpay could not process the refund' : null,
          ...(completed && amount >= Number(locked.pricing.total) ? { paymentStatus: 'Refunded' } : {}),
        },
        $push: {
          statusHistory: {
            status: completed ? 'Refund Completed' : failed ? 'Refund Failed' : 'Refund Initiated',
            timestamp: new Date(),
            note: `Razorpay refund of Rs.${amount} ${completed ? 'completed' : failed ? 'failed' : 'initiated'}. Refund ID: ${refund.id}`,
          },
        },
      },
      { new: true }
    );

    if (completed && amount >= Number(locked.pricing.total)) {
      await Payment.findOneAndUpdate(
        { razorpayPaymentId: locked.razorpayPaymentId },
        { status: 'refunded' }
      );
    }

    return { order: updated, refund, required: true, completed, failed };
  } catch (error) {
    // Keep the same key for a safe retry. This also covers an ambiguous network
    // failure where Razorpay may have accepted the first request.
    const updated = await ProductOrder.findByIdAndUpdate(
      locked._id,
      {
        $set: {
          'refundDetails.status': 'Failed',
          'refundDetails.failureReason': error.message,
          'refundDetails.lastRetryAt': new Date(),
        },
        $push: {
          statusHistory: {
            status: 'Refund Failed',
            timestamp: new Date(),
            note: `Automatic refund needs attention: ${error.message}`,
          },
        },
      },
      { new: true }
    );
    error.order = updated;
    throw error;
  }
}

module.exports = {
  ONLINE_METHODS,
  restoreStockOnce,
  initiateOnlineRefund,
};
