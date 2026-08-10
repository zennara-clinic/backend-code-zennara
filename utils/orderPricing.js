/**
 * Authoritative, server-side pricing for product orders.
 *
 * The mobile app sends a cart and its own idea of the totals, but the amount we
 * charge and store must NEVER come from the client — otherwise a tampered app
 * can pay ₹1 for a full-value cart or claim an arbitrary discount. Everything
 * here is recomputed from the database: product prices, per-product GST, the
 * delivery-fee rule, and the coupon (validated, not trusted).
 *
 * This does NOT mutate stock. Callers still do their own atomic stock decrement
 * after pricing succeeds, so validation and the actual reservation stay separate.
 */
const Product = require('../models/Product');
const Coupon = require('../models/Coupon');

// Delivery rule — mirrors the app's checkout display.
const FREE_DELIVERY_THRESHOLD = 500;
const DELIVERY_FEE = 40;

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
 * @param {{ items: Array<{productId:string, quantity:number}>, couponCode?: string, userId?: any }} params
 * @returns {Promise<
 *   | { ok:false, status:number, message:string, availableStock?:number }
 *   | { ok:true, pricing:{subtotal:number,gst:number,discount:number,deliveryFee:number,total:number},
 *       items: Array<{product:object, quantity:number}>, coupon: {code:string,discount:number}|null }
 * >}
 */
async function computeOrderPricing({ items, couponCode }) {
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
    if (product.stock < item.quantity) {
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
  const deliveryFee = subtotal > FREE_DELIVERY_THRESHOLD ? 0 : DELIVERY_FEE;

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
  FREE_DELIVERY_THRESHOLD,
  DELIVERY_FEE,
};
