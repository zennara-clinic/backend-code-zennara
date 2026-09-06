/**
 * Move Commerce stock and write the product's ledger row in one place.
 * Idempotent per (source, refId, productId): a second call with the same key
 * is a no-op and returns { applied: false }.
 */
const Product = require('../models/Product');
const ProductStockMovement = require('../models/ProductStockMovement');

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

module.exports = { moveStock, setStock };
