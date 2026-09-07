const mongoose = require('mongoose');
const ProductOrder = require('../models/ProductOrder');
const Product = require('../models/Product');
const ProductStockMovement = require('../models/ProductStockMovement');
const Payment = require('../models/Payment');
const razorpayService = require('./razorpayService');

const ONLINE_METHODS = new Set(['Razorpay', 'Online']);

const asId = (value) => value?._id || value || null;

/**
 * The Razorpay idempotency key for one refund. `alreadyRefunded` is part of it
 * so a second part refund of the same amount is a distinct request rather than
 * a duplicate of the first — otherwise refunding Rs.500 twice on a Rs.1000
 * order would silently return only Rs.500.
 */
const refundKeyFor = (order, amount, alreadyRefunded = 0) => {
  const paise = Math.round(Number(amount) * 100);
  const done = Math.round(Number(alreadyRefunded) * 100);
  return done > 0
    ? `order_${String(order._id)}_refund_${paise}_after_${done}`
    : `order_${String(order._id)}_refund_${paise}`;
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

      /*
       * Only products whose stock is actually counted. An untracked product
       * is never decremented when the order is placed, so adding its quantity
       * back here invented stock that was never reserved.
       */
      const tracked = await Product.find({
        _id: { $in: order.items.map((i) => asId(i.productId)).filter(Boolean) },
        trackStock: { $ne: false },
      }).select('_id').session(session).lean();
      const trackedIds = new Set(tracked.map((p) => String(p._id)));
      const restorable = order.items.filter((item) => trackedIds.has(String(item.productId)));

      const operations = restorable.map((item) => ({
        updateOne: {
          filter: { _id: asId(item.productId) },
          update: { $inc: { stock: Number(item.quantity) } },
        },
      }));

      if (operations.length) {
        await Product.bulkWrite(operations, { session });
        ProductStockMovement.insertMany(
          restorable.map((item) => ({ productId: asId(item.productId), source: 'app-order', refId: `${order._id}:restore:${item.productId}`, delta: Number(item.quantity), note: `Order ${order.orderNumber || order._id} — ${reason}` })),
          { ordered: false },
        ).catch(() => {});
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

  /*
   * Part refunds. `amountRefunded` is the running total actually returned;
   * the balance is what may still be refunded. The Razorpay idempotency key is
   * pinned only while a refund is IN FLIGHT — once one settles the key is
   * retired, so a second part refund is a new request rather than a rejected
   * retry of the first.
   */
  const total = Number(order.pricing.total);
  const alreadyRefunded = Number(order.refundDetails?.amountRefunded || 0);
  const remaining = Math.round((total - alreadyRefunded) * 100) / 100;
  const inFlight = order.refundDetails?.status === 'Processing';
  /*
   * A previous attempt that never settled — still processing, or failed
   * ambiguously — keeps its Razorpay key, amount and notes so a retry cannot
   * refund twice. Only a COMPLETED refund retires the key, which is what lets
   * a second part refund start a fresh request.
   */
  const unsettled = !!order.refundDetails?.idempotencyKey
    && ['Processing', 'Failed'].includes(order.refundDetails?.status);

  const requestedAmount = options.amount == null ? remaining : Number(options.amount);
  const amount = unsettled && Number(order.refundDetails.amount) > 0
    ? Number(order.refundDetails.amount)
    : requestedAmount;
  if (unsettled && Math.round(requestedAmount * 100) !== Math.round(amount * 100)) {
    throw new Error('A retry must use the same refund amount as the original request');
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Invalid refund amount');
  }
  if (Math.round(amount * 100) > Math.round(remaining * 100)) {
    throw new Error(
      alreadyRefunded > 0
        ? `Only Rs.${remaining.toFixed(2)} of this order is still refundable (Rs.${alreadyRefunded.toFixed(2)} already returned)`
        : 'Invalid refund amount',
    );
  }

  if (!ONLINE_METHODS.has(order.paymentMethod)) {
    // Not a Razorpay payment (a clinic-counter sale, say). Nothing can be sent
    // automatically — say so plainly rather than reporting a refund that never
    // happened. The caller surfaces this to the person at the desk.
    return {
      order,
      required: order.paymentStatus === 'Paid',
      manual: true,
      reason: `This order was paid by ${order.paymentMethod || 'another method'}, not Razorpay, so it cannot be refunded automatically. Return the money at the clinic and record it here.`,
    };
  }
  if (!['Paid', 'Refunded', 'Partially Refunded'].includes(order.paymentStatus)) {
    return { order, required: false, skipped: true };
  }
  if (!order.razorpayPaymentId) {
    throw new Error('Paid online order has no Razorpay payment ID');
  }

  if (remaining <= 0) {
    return { order, required: true, alreadyCompleted: true, amountRefunded: alreadyRefunded };
  }
  if (inFlight) {
    return { order, required: true, alreadyProcessing: true };
  }

  // The key covers this refund only; a later part refund gets its own.
  const idempotencyKey = unsettled
    ? order.refundDetails.idempotencyKey
    : refundKeyFor(order, amount, alreadyRefunded);
  const now = new Date();
  const actorId = asId(options.actorId);
  const trigger = unsettled ? (order.refundDetails.trigger || 'manual') : (options.trigger || 'manual');
  const refundNotes = unsettled
    ? (order.refundDetails.notes || 'Refund initiated to the original payment method')
    : (options.notes || 'Refund initiated to the original payment method');

  const locked = await ProductOrder.findOneAndUpdate(
    {
      _id: order._id,
      paymentStatus: { $ne: 'Refunded' },
      // 'Completed' is allowed through when a balance remains — that is a new
      // part refund, not a retry of the settled one.
      'refundDetails.status': { $ne: 'Processing' },
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
          // Cumulative, so the order knows how much of it is still refundable.
          ...(completed
            ? {
                paymentStatus:
                  Math.round((alreadyRefunded + amount) * 100) >= Math.round(Number(locked.pricing.total) * 100)
                    ? 'Refunded'
                    : 'Partially Refunded',
              }
            : {}),
        },
        ...(completed ? { $inc: { 'refundDetails.amountRefunded': amount } } : {}),
        $push: {
          'refundDetails.history': {
            amount,
            razorpayRefundId: refund.id,
            status: completed ? 'Completed' : failed ? 'Failed' : 'Processing',
            at: new Date(),
            by: actorId,
            note: refundNotes,
          },
          statusHistory: {
            status: completed ? 'Refund Completed' : failed ? 'Refund Failed' : 'Refund Initiated',
            timestamp: new Date(),
            note: `Razorpay refund of Rs.${amount} ${completed ? 'completed' : failed ? 'failed' : 'initiated'}. Refund ID: ${refund.id}`,
          },
        },
      },
      { new: true }
    );

    // Keep the payment record in step with the order: they used to disagree,
    // so a part-refunded order still read as fully captured on the payment side.
    if (completed) {
      const settled = Math.round((alreadyRefunded + amount) * 100);
      const full = Math.round(Number(locked.pricing.total) * 100);
      await Payment.findOneAndUpdate(
        { razorpayPaymentId: locked.razorpayPaymentId },
        { status: settled >= full ? 'refunded' : 'partially_refunded' }
      ).catch(() => {});
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
