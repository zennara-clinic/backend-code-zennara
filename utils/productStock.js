/**
 * Move Commerce stock and write the product's ledger row in one place.
 * Idempotent per (source, refId, productId): a second call with the same key
 * is a no-op and returns { applied: false }.
 */
const Product = require('../models/Product');
const ProductStockMovement = require('../models/ProductStockMovement');

/**
 * What a product starts with when nobody has entered a count. Without it a
 * newly listed product reads "out of stock" until someone remembers to type a
 * number. Set STORE_DEFAULT_STOCK to change it; the panel overrides it per
 * product, and entering 0 there still means sold out.
 */
const DEFAULT_OPENING_STOCK = (() => {
  const n = Number(process.env.STORE_DEFAULT_STOCK);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 100;
})();

/** The stock to store for what the panel sent: blank or missing = the default, a number = that number. */
function openingStock(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_OPENING_STOCK;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_OPENING_STOCK;
}

async function moveStock({ productId, delta, source, refId = null, note = null, by = null, floorAtZero = true }) {
  const d = Number(delta);
  if (!productId || !Number.isFinite(d) || d === 0) return { applied: false, reason: 'nothing to move' };
  const before = await Product.findById(productId).select('stock trackStock').lean();
  if (!before) return { applied: false, reason: 'no product' };
  const key = refId !== null && refId !== undefined ? String(refId) : null;
  if (key) {
    const dup = await ProductStockMovement.exists({ source, refId: key, productId });
    if (dup) return { applied: false, reason: 'already applied' };
  }
  const current = Number(before.stock) || 0;
  const next = floorAtZero ? Math.max(0, current + d) : current + d;
  await Product.updateOne({ _id: productId }, { $set: { stock: next, stockSource: source, stockUpdatedAt: new Date() } });
  try {
    await ProductStockMovement.create({ productId, source, refId: key, delta: next - current, before: current, after: next, note, by });
  } catch (err) {
    if (err && err.code === 11000) return { applied: false, reason: 'already applied' };
    throw err;
  }
  return { applied: true, before: current, after: next };
}

/** A reset (template import / panel edit): records the jump, no idempotency key. */
async function setStock({ productId, stock, source, note = null, by = null }) {
  const before = await Product.findById(productId).select('stock').lean();
  if (!before) return { applied: false };
  const current = Number(before.stock) || 0; const next = Math.max(0, Number(stock) || 0);
  await Product.updateOne({ _id: productId }, { $set: { stock: next, stockSource: source, stockUpdatedAt: new Date() } });
  if (next !== current) await ProductStockMovement.create({ productId, source, refId: null, delta: next - current, before: current, after: next, note, by });
  return { applied: true, before: current, after: next };
}

module.exports = { moveStock, setStock, openingStock, DEFAULT_OPENING_STOCK };
