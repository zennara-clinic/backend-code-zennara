/**
 * Valuation of a stock row, three ways (Zenoti's Current Stock columns):
 *   avg          — moving-average cost from goods receipts (falls back to the buying price)
 *   configured   — the selling price on the item
 *   lastProcured — the most recent purchase-order price
 * Each returns { unit, cost, tax } where cost = unit × on hand and tax = GST on cost.
 */
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function unitCost(row, basis = 'avg') {
  if (basis === 'configured') return Number(row.inventorySellingPrice) || Number(row.batchSellingPrice) || 0;
  if (basis === 'lastProcured') return Number(row.lastProcuredPrice) || Number(row.inventoryBuyingPrice) || Number(row.batchBuyingPrice) || 0;
  return Number(row.avgCost) || Number(row.inventoryBuyingPrice) || Number(row.batchBuyingPrice) || 0;
}

function valueRow(row, basis = 'avg') {
  const qty = Math.max(0, Number(row.qohAllBatches) || 0);
  const unit = unitCost(row, basis);
  const cost = r2(qty * unit);
  const gst = Number(row.gstPercentage) || 0;
  return { unit, qty, cost, tax: r2(cost * gst / 100) };
}

function summarise(rows, basis = 'avg') {
  const out = { items: rows.length, inStock: 0, onHand: 0, cost: 0, tax: 0, configured: 0, lastProcured: 0, byCategory: {} };
  for (const row of rows) {
    const v = valueRow(row, basis);
    const cfg = valueRow(row, 'configured');
    const lp = valueRow(row, 'lastProcured');
    if (v.qty > 0) out.inStock += 1;
    out.onHand += v.qty; out.cost += v.cost; out.tax += v.tax; out.configured += cfg.cost; out.lastProcured += lp.cost;
    const k = row.inventoryCategory || 'Other';
    const c = out.byCategory[k] || (out.byCategory[k] = { items: 0, onHand: 0, cost: 0 });
    c.items += 1; c.onHand += v.qty; c.cost = r2(c.cost + v.cost);
  }
  for (const k of ['cost', 'tax', 'configured', 'lastProcured']) out[k] = r2(out[k]);
  return out;
}

module.exports = { unitCost, valueRow, summarise, r2 };
