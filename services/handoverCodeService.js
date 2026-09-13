/**
 * Issuing and checking the handover code for a product order.
 *
 * One code, one meaning, both flows: the guest reads it out and whoever hands
 * the order over types it in. Store pickup gets its code when the order is
 * created — the guest can walk in the moment we say it is ready — and delivery
 * gets one when a rider is assigned, because until then there is nobody to
 * show it to.
 *
 * Issuing and delivering the message live together here so no call site can do
 * one without the other: a code the guest never received is a code that stops
 * their own order at the door.
 */

const ProductOrder = require('../models/ProductOrder');
const User = require('../models/User');
const Branch = require('../models/Branch');
const whatsappService = require('./whatsappService');
const emailService = require('../utils/emailService');
const logger = require('../utils/logger');
const { clinicHoursLine } = require('../utils/centreHours');
const {
  isPickup, typeOf, generateHandoverCode, normaliseHandoverCode, handoverAudience, recipientName,
} = require('../utils/orderFulfilment');

/** Statuses where a code is spent or void, so its value may be reused. */
const CLOSED = ['Collected', 'Delivered', 'Cancelled', 'Returned'];

/** A value no other live order is carrying. */
async function freshCode() {
  for (let i = 0; i < 8; i += 1) {
    const code = generateHandoverCode();
    const clash = await ProductOrder.exists({ 'handover.code': code, orderStatus: { $nin: CLOSED } });
    if (!clash) return code;
  }
  // Eight collisions against a 480-million space means something is wrong with
  // the generator, not with luck — but refusing to hand over a code would stop
  // the order, so take the last one and let the uniqueness check at the desk
  // (code + this order) carry it.
  return generateHandoverCode();
}

/**
 * What the messages say. The two flows differ in where the guest goes and who
 * they show it to, and in nothing else.
 */
async function messageData(order, user) {
  const pickup = isPickup(order);
  const centre = pickup && order.fulfilment?.branchId
    ? await Branch.findById(order.fulfilment.branchId).select('name operatingHours').lean().catch(() => null)
    : null;
  const a = order.fulfilment?.pickupAddress || {};
  const s = order.shippingAddress || {};
  return {
    customerName: recipientName(order, user),
    orderNumber: order.orderNumber,
    code: order.handover?.code || '',
    fulfilment: typeOf(order),
    showTo: handoverAudience(order),
    centreName: order.fulfilment?.branchName || centre?.name || null,
    centreAddress: pickup ? [a.addressLine1, a.city, a.pincode].filter(Boolean).join(', ') || null : null,
    centrePhone: a.phone || null,
    centreHours: centre ? clinicHoursLine(centre) : null,
    deliveryAddress: pickup ? null : [s.addressLine1, s.city, s.postalCode].filter(Boolean).join(', ') || null,
    deliveryPartner: pickup ? null : (order.deliveryPartner || order.courier || null),
    trackingId: pickup ? null : (order.trackingId || null),
  };
}

/**
 * Send the code to WhatsApp and email, and record where it went.
 *
 * A failed channel is logged and does not fail the caller: the code is also in
 * the app, and refusing to assign a rider because an email bounced would be
 * the wrong trade. `sentChannels` records what actually got through, so the
 * panel can tell the desk whether the guest has it.
 */
async function send(order, user) {
  if (!order.handover?.code) return order;
  const data = await messageData(order, user);
  const channels = [];

  if (user?.phone) {
    try {
      await whatsappService.sendHandoverCode(user.phone, data);
      channels.push('whatsapp');
    } catch (error) {
      logger.warn('Handover code WhatsApp failed', { orderId: String(order._id), error: error.message });
    }
  }
  if (user?.email) {
    try {
      await emailService.sendHandoverCodeEmail(user.email, data.customerName, data);
      channels.push('email');
    } catch (error) {
      logger.warn('Handover code email failed', { orderId: String(order._id), error: error.message });
    }
  }

  order.handover.sentAt = new Date();
  order.handover.sentChannels = channels;
  await ProductOrder.updateOne(
    { _id: order._id },
    { $set: { 'handover.sentAt': order.handover.sentAt, 'handover.sentChannels': channels } },
  ).catch(() => {});
  return order;
}

/**
 * Give this order a code and tell the guest what it is.
 *
 * Idempotent per flow: an order that already holds a live code for the same
 * flow keeps it (re-assigning a rider must not change a code the guest has
 * already written down), and `resend` re-sends that same code.
 *
 * @param {object} order a ProductOrder document
 * @param {{ resend?: boolean, user?: object }} [options]
 */
async function issue(order, { resend = false, user = null } = {}) {
  const flow = typeOf(order);
  const existing = order.handover?.code && order.handover.issuedFor === flow;
  if (!existing) {
    order.handover = {
      ...(order.handover ? order.handover.toObject?.() ?? order.handover : {}),
      code: await freshCode(),
      issuedFor: flow,
      issuedAt: new Date(),
      sentAt: null,
      sentChannels: [],
      verifiedAt: null,
      verifiedBy: null,
      method: null,
      note: null,
    };
    await ProductOrder.updateOne({ _id: order._id }, { $set: { handover: order.handover } });
  } else if (!resend) {
    return order;
  }

  const guest = user || await User.findById(order.userId).select('fullName email phone').lean().catch(() => null);
  return send(order, guest);
}

/**
 * Does `typed` open this order?
 *
 * @returns {{ ok: true, method: 'code' }
 *   | { ok: true, method: 'override', note: string }
 *   | { ok: false, code: string, message: string }}
 */
function verify(order, { typed, override = false, note = '' } = {}) {
  const expected = normaliseHandoverCode(order.handover?.code);
  const given = normaliseHandoverCode(typed);
  const audience = handoverAudience(order);

  if (override) {
    if (String(note || '').trim().length < 4) {
      return {
        ok: false,
        code: 'HANDOVER_NOTE_REQUIRED',
        message: 'Say how the guest was identified when handing over without the code.',
      };
    }
    return { ok: true, method: 'override', note: String(note).trim() };
  }

  if (!expected) {
    return {
      ok: false,
      code: 'HANDOVER_CODE_MISSING',
      message: `This order has no handover code yet. Issue one, or record how the guest was identified for ${audience}.`,
    };
  }
  if (!given) {
    return {
      ok: false,
      code: 'HANDOVER_CODE_REQUIRED',
      message: 'Enter the code the guest reads out, or record how they were identified instead.',
    };
  }
  if (given !== expected) {
    return { ok: false, code: 'HANDOVER_CODE_MISMATCH', message: 'That code does not match this order.' };
  }
  return { ok: true, method: 'code' };
}

/** Stamp a completed handover onto the order (the caller still saves it). */
function markVerified(order, result, adminId = null) {
  const now = new Date();
  order.handover = order.handover || {};
  order.handover.verifiedAt = now;
  order.handover.verifiedBy = adminId || null;
  order.handover.method = result.method;
  order.handover.note = result.method === 'override' ? result.note : null;
  return now;
}

module.exports = { issue, send, verify, markVerified, freshCode, messageData, CLOSED };
