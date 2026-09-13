/**
 * How a product order is fulfilled: sent to the guest's door, or collected
 * by the guest at a clinic centre.
 *
 * Both flows are prepaid through Razorpay. The difference is what happens
 * after payment: a DELIVERY order is packed, shipped and handed over by a
 * courier; a PICKUP order is packed, put aside at the chosen centre, and the
 * guest walks in and shows a short code to take it. No delivery fee is
 * charged for pickup — that is the point of it.
 *
 * Everything that depends on the type — the status ladder, which statuses a
 * guest may cancel from, what "fulfilled" means, the labels — is defined
 * here once, so the admin status handler, the guest cancel/return handlers,
 * the analytics and the notifications cannot drift apart.
 */

const FULFILMENT_TYPES = Object.freeze(['delivery', 'pickup']);

/** Forward-only ladders. Cancelled / returns sit outside both. */
const DELIVERY_SEQUENCE = Object.freeze([
  'Order Placed', 'Confirmed', 'Processing', 'Packed', 'Shipped', 'Out for Delivery', 'Delivered',
]);
const PICKUP_SEQUENCE = Object.freeze([
  'Order Placed', 'Confirmed', 'Processing', 'Packed', 'Ready for Pickup', 'Collected',
]);

/** Statuses that belong to one flow only; requesting them on the other is a mistake. */
const DELIVERY_ONLY = new Set(['Shipped', 'Out for Delivery', 'Delivery Failed', 'Delivered']);
const PICKUP_ONLY = new Set(['Ready for Pickup', 'Collected']);

/** The order reached the guest — the end of the happy path in either flow. */
const FULFILLED = new Set(['Delivered', 'Collected']);
/** Nothing further can happen to the order except money and returns. */
const TERMINAL = new Set(['Delivered', 'Collected', 'Cancelled', 'Returned', 'Return Requested']);

/**
 * From which statuses the GUEST may cancel in the app. Delivery keeps
 * 'Delivery Failed' (the parcel is on its way back). Pickup allows cancelling
 * right up to and including 'Ready for Pickup' — the parcel has not left the
 * building, so the desk simply unpacks it and the refund goes out.
 */
const CUSTOMER_CANCELLABLE = Object.freeze({
  delivery: ['Order Placed', 'Confirmed', 'Processing', 'Packed', 'Delivery Failed'],
  pickup: ['Order Placed', 'Confirmed', 'Processing', 'Packed', 'Ready for Pickup'],
});

const STATUS_LABEL = Object.freeze({
  'Order Placed': 'Order placed',
  Confirmed: 'Confirmed',
  Processing: 'Being prepared',
  Packed: 'Packed',
  Shipped: 'Shipped',
  'Out for Delivery': 'Out for delivery',
  'Delivery Failed': 'Delivery attempt failed',
  Delivered: 'Delivered',
  'Ready for Pickup': 'Ready to collect',
  Collected: 'Collected',
  Cancelled: 'Cancelled',
  'Return Requested': 'Return requested',
  Returned: 'Returned',
});

const typeOf = (order) => (order?.fulfilment?.type === 'pickup' ? 'pickup' : 'delivery');
const isPickup = (order) => typeOf(order) === 'pickup';
const sequenceFor = (order) => (isPickup(order) ? PICKUP_SEQUENCE : DELIVERY_SEQUENCE);
const isFulfilled = (status) => FULFILLED.has(status);
const isTerminal = (status) => TERMINAL.has(status);
const customerCancellable = (order) => CUSTOMER_CANCELLABLE[typeOf(order)];

/** When the guest received the goods (return windows count from here). */
const fulfilledAt = (order) => order?.fulfilment?.collectedAt || order?.deliveredAt || null;

/**
 * Why `status` cannot be applied to `order`, or null when it can — the
 * per-flow half of the admin status rules (the shared rules — forward only,
 * terminal states — stay in the handler).
 */
function statusMismatch(order, status) {
  if (isPickup(order) && DELIVERY_ONLY.has(status)) {
    return `A store-pickup order is never ${STATUS_LABEL[status].toLowerCase()} — it is collected at ${order.fulfilment?.branchName || 'the centre'}.`;
  }
  if (!isPickup(order) && PICKUP_ONLY.has(status)) {
    return 'Only a store-pickup order can be marked ready to collect or collected.';
  }
  return null;
}

/*
 * Pickup codes.
 *
 * Six characters from an alphabet with no 0/O, 1/I/L or 5/S, so a code read
 * out at the desk or over the phone cannot be misheard. 28^6 ≈ 480 million —
 * uniqueness is still enforced against open pickup orders by the caller.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRTUVWXYZ234679';
function generatePickupCode(random = Math.random) {
  let out = '';
  for (let i = 0; i < 6; i += 1) out += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  return out;
}
const normalisePickupCode = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Where the goods go, in one line, for messages and the panel: the delivery
 * address for a delivery order, the centre for a pickup order.
 */
function destinationLine(order) {
  if (isPickup(order)) {
    const a = order.fulfilment?.pickupAddress || {};
    const parts = [order.fulfilment?.branchName, a.addressLine1, a.city].filter(Boolean);
    return `Collect at ${parts.join(', ')}`;
  }
  const s = order.shippingAddress || {};
  return [s.addressLine1, s.city, s.state && s.postalCode ? `${s.state} - ${s.postalCode}` : s.state || s.postalCode].filter(Boolean).join(', ');
}

/** The guest's name for a message: the address name for delivery, else the account. */
const recipientName = (order, user) => order?.shippingAddress?.fullName || user?.fullName || 'there';

module.exports = {
  FULFILMENT_TYPES,
  DELIVERY_SEQUENCE,
  PICKUP_SEQUENCE,
  DELIVERY_ONLY,
  PICKUP_ONLY,
  FULFILLED,
  CUSTOMER_CANCELLABLE,
  STATUS_LABEL,
  typeOf,
  isPickup,
  sequenceFor,
  isFulfilled,
  isTerminal,
  customerCancellable,
  fulfilledAt,
  statusMismatch,
  generatePickupCode,
  normalisePickupCode,
  destinationLine,
  recipientName,
};
