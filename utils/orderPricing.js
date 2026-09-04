/**
 * Authoritative, server-side pricing for product orders.
 *
 * The mobile app sends a cart and its own idea of the totals, but the amount we
 * charge and store must NEVER come from the client — otherwise a tampered app
 * can pay ₹1 for a full-value cart or claim an arbitrary discount. Everything
 * here is recomputed from the database: product prices, per-product GST, the
 * delivery-fee rule, the minimum-order rule, and the coupon (validated, not
 * trusted).
 *
 * This does NOT mutate stock. Callers still do their own atomic stock decrement
 * after pricing succeeds, so validation and the actual reservation stay separate.
 */
const Product = require('../models/Product');
const Coupon = require('../models/Coupon');

/**
 * Commercial rules for the store (2026-09 policy).
 *
 *   • Minimum cart value is ₹1,000 on the SUBTOTAL — before GST, before the
 *     delivery fee and before any coupon. Pricing a cart under that returns
 *     ok:false, so checkout, the Razorpay order and order creation all refuse
 *     it at the same place rather than each re-implementing the check.
 *   • Delivery is a flat ₹150. It used to be "free over ₹500, else ₹40", which
 *     cannot survive a ₹1,000 floor — every order would have shipped free.
 *   • Cash on delivery is gone; see models/ProductOrder.js. Nothing here
 *     depends on the payment method, but the floor is what makes prepaid-only
 *     viable, so the two ship together.
 *
 * Overridable by env so a promotion never needs a deploy. City-specific fees
 * live in DELIVERY_FEE_BY_CITY (lowercased, trimmed keys); anything not listed
 * falls back to DELIVERY_FEE.
 */
const MIN_ORDER_VALUE = Number(process.env.STORE_MIN_ORDER_VALUE || 1000);
const DELIVERY_FEE = Number(process.env.STORE_DELIVERY_FEE || 150);

const DELIVERY_FEE_BY_CITY = (() => {
  try {
    const raw = process.env.STORE_DELIVERY_FEE_BY_CITY;
    if (!raw) return { hyderabad: DELIVERY_FEE, secunderabad: DELIVERY_FEE };
    const parsed = JSON.parse(raw);
    return Object.fromEntries(
      Object.entries(parsed).map(([k, v]) => [String(k).trim().toLowerCase(), Number(v)]),
    );
  } catch (_) {
    return { hyderabad: DELIVERY_FEE, secunderabad: DELIVERY_FEE };
  }
})();

/** Flat fee for a delivery city. Unknown/blank city → the standard fee. */
function deliveryFeeForCity(city) {
  const key = String(city || '').trim().toLowerCase();
  const hit = DELIVERY_FEE_BY_CITY[key];
  return Number.isFinite(hit) ? hit : DELIVERY_FEE;
}

/** Human copy for a rejected cart, shared by every caller so it reads the same. */
function belowMinimumMessage(subtotal) {
  const short = Math.max(0, MIN_ORDER_VALUE - subtotal);
  return `Minimum order value is ₹${MIN_ORDER_VALUE}. Add ₹${short} more to place this order.`;
}

/**
 * Validate a coupon for an order and return the authoritative discount.
 * Returns { ok:false } for any invalid/expired/ineligible coupon (the order then
 * proceeds at full price rather than failing checkout).
 */
async function validateCouponForOrder(code, orderValue, productIds) {
  if (!code) return { ok: false };
  const coupon = await Coupon.findOne({ code: String(code).toUpperCase() });
  if (!coupon || !coupon.isActive) return { ok: false };

  const now = new Date();
  if (coupon.validFrom && now < coupon.validFrom) return { ok: false };
  if (coupon.validUntil && now > coupon.validUntil) return { ok: false };
  if (coupon.usageLimit && coupon.usageCount >= coupon.usageLimit) return { ok: false };
  if (coupon.minOrderValue && orderValue < coupon.minOrderValue) return { ok: false };

  if (coupon.applicableProducts && coupon.applicableProducts.length > 0) {
    const applicable = coupon.applicableProducts.map(String);
    const hasApplicable = productIds.some((id) => applicable.includes(String(id)));
    if (!hasApplicable) return { ok: false };
  }

  let discount = 0;
  if (coupon.discountType === 'percentage') {
    discount = (orderValue * coupon.discountValue) / 100;
    if (coupon.maxDiscount && discount > coupon.maxDiscount) discount = coupon.maxDiscount;
  } else {
    discount = coupon.discountValue;
  }
  // Never let a discount exceed the order value.
  discount = Math.min(Math.round(discount), orderValue);
  return { ok: true, code: coupon.code, discount };
}

/**
 * Price an order from the database.
 *
 * @param {{ items: Array<{productId:string, quantity:number}>, couponCode?: string, city?: string, userId?: any }} params
 * @returns {Promise<
 *   | { ok:false, status:number, message:string, availableStock?:number }
 *   | { ok:true, pricing:{subtotal:number,gst:number,discount:number,deliveryFee:number,total:number},
 *       items: Array<{product:object, quantity:number}>, coupon: {code:string,discount:number}|null }
 * >}
 */
async function computeOrderPricing({ items, couponCode, city }) {
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, status: 400, message: 'Order must contain at least one item' };
  }

  let subtotal = 0;
  let gst = 0;
  const productIds = [];
  const lineItems = [];

  for (const item of items) {
    if (!item.productId || !item.quantity || item.quantity <= 0) {
      return { ok: false, status: 400, message: 'Invalid item data in cart' };
    }

    const product = await Product.findById(item.productId);
    if (!product) {
      return { ok: false, status: 404, message: `Product not found: ${item.productId}` };
    }
    if (!product.isActive) {
      return { ok: false, status: 400, message: `Product is not available: ${product.name}` };
    }
    // trackStock false = no count exists for this product (Zenoti-mirrored);
    // the sale goes through and nothing is decremented.
    if (product.trackStock !== false && product.stock < item.quantity) {
      return {
        ok: false,
        status: 400,
        message: `Insufficient stock for ${product.name}. Available: ${product.stock}`,
        availableStock: product.stock,
      };
    }

    const lineSubtotal = product.price * item.quantity;
    subtotal += lineSubtotal;
    gst += (lineSubtotal * (product.gstPercentage || 0)) / 100;
    productIds.push(product._id.toString());
    lineItems.push({ product, quantity: item.quantity });
  }

  gst = Math.round(gst);

  // Minimum-order gate. Deliberately on the subtotal, so adding GST or paying a
  // delivery fee can never lift an under-value cart over the line.
  if (subtotal < MIN_ORDER_VALUE) {
    return {
      ok: false,
      status: 400,
      code: 'BELOW_MIN_ORDER',
      minOrderValue: MIN_ORDER_VALUE,
      subtotal,
      message: belowMinimumMessage(subtotal),
    };
  }

  const deliveryFee = deliveryFeeForCity(city);

  let discount = 0;
  let coupon = null;
  if (couponCode) {
    const result = await validateCouponForOrder(couponCode, subtotal, productIds);
    if (result.ok) {
      discount = result.discount;
      coupon = { code: result.code, discount: result.discount };
    }
    // Invalid coupon → no discount (never trust the client's claimed discount).
  }

  const total = Math.max(0, subtotal + gst - discount + deliveryFee);

  return {
    ok: true,
    pricing: { subtotal, gst, discount, deliveryFee, total },
    items: lineItems,
    coupon,
  };
}

module.exports = {
  computeOrderPricing,
  validateCouponForOrder,
  deliveryFeeForCity,
  belowMinimumMessage,
  MIN_ORDER_VALUE,
  DELIVERY_FEE,
};
