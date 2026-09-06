/**
 * Reading Zenoti's own stock exports.
 *
 * Zenoti's inventory API answers 401 for our key (stock, adjustments, purchase
 * orders and transfers are all outside its scope — verified 2026-09-06), while
 * the clinic already exports these screens to Excel every week:
 *   Inventory › Retail/Consumable › Current stock  → Export
 *   Inventory › Retail/Consumable › Audit inventory → Export
 * Those files carry exactly what the API withholds: on-hand quantity per
 * centre, batch numbers, expiry dates, vendor and the value Zenoti holds the
 * stock at. This reads either export, whatever its column order, and matches
 * the rows to our per-centre shelf.
 *
 * Nothing here writes to Zenoti.
 */

/** Normalise a header cell so "Current On-Hand Qty" and "on hand qty" match. */
const norm = (s) => String(s || '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Header aliases seen in Zenoti's Current Stock and Audit Inventory exports.
 * The first match wins, so put the most specific alias first.
 */
const FIELDS = {
  code: ['code', 'product code', 'item code', 'sku', 'barcode'],
  name: ['product', 'product name', 'name', 'item', 'item name'],
  quantity: ['current on hand qty', 'on hand quantity', 'on hand qty', 'onhand qty', 'current stock', 'closing stock', 'quantity', 'qty', 'stock'],
  unit: ['unit', 'uom'],
  vendor: ['vendor', 'vendor name', 'supplier'],
  category: ['category'],
  subCategory: ['sub category', 'subcategory'],
  brand: ['brand'],
  cost: ['value considered', 'avg value', 'average value', 'stock cost', 'unit price', 'cost', 'unit cost', 'last procured value'],
  batchNo: ['batch', 'batch no', 'batch number', 'b no', 'batch details'],
  expiry: ['expiry', 'expiry date', 'exp', 'exp date', 'expiration date'],
  notes: ['notes', 'note', 'remarks'],
};

/** Map the sheet's headers onto our field names. */
function mapHeaders(headers) {
  const map = {};
  const seen = new Set();
  for (const raw of headers) {
    const n = norm(raw);
    if (!n) continue;
    for (const [field, aliases] of Object.entries(FIELDS)) {
      if (seen.has(field)) continue;
      if (aliases.some((a) => n === a || n.startsWith(`${a} `) || n.endsWith(` ${a}`))) {
        map[raw] = field; seen.add(field); break;
      }
    }
  }
  return map;
}

const numberOf = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

/** dd-MM-yyyy, dd/MM/yyyy and ISO all appear in Zenoti exports. */
function dateOf(v) {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const s = String(v).trim();
  const dmy = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    const year = Number(y.length === 2 ? `20${y}` : y);
    const dt = new Date(Date.UTC(year, Number(m) - 1, Number(d)));
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  const dt = new Date(s);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/**
 * Turn an exported sheet into rows we can apply.
 * `rows` is what utils/bulkCsv.readWorkbook returns (array of objects).
 */
function parseStockSheet(rows) {
  if (!Array.isArray(rows) || !rows.length) return { rows: [], headerMap: {}, missing: ['file is empty'] };
  const headerMap = mapHeaders(Object.keys(rows[0]));
  const fields = new Set(Object.values(headerMap));
  const missing = [];
  if (!fields.has('code') && !fields.has('name')) missing.push('a product code or product name column');
  if (!fields.has('quantity')) missing.push('an on-hand quantity column');

  const out = [];
  for (const raw of rows) {
    const r = {};
    for (const [header, field] of Object.entries(headerMap)) r[field] = raw[header];
    const code = r.code ? String(r.code).trim() : null;
    const name = r.name ? String(r.name).trim() : null;
    if (!code && !name) continue;
    const quantity = numberOf(r.quantity);
    if (quantity === null) continue;
    out.push({
      code, name,
      quantity: Math.max(0, quantity),
      unit: r.unit ? String(r.unit).trim() : null,
      vendor: r.vendor ? String(r.vendor).trim() : null,
      category: r.category ? String(r.category).trim() : null,
      subCategory: r.subCategory ? String(r.subCategory).trim() : null,
      brand: r.brand ? String(r.brand).trim() : null,
      cost: numberOf(r.cost),
      batchNo: r.batchNo ? String(r.batchNo).trim() : null,
      expiry: dateOf(r.expiry),
      notes: r.notes ? String(r.notes).trim() : null,
    });
  }
  return { rows: out, headerMap, missing };
}

module.exports = { parseStockSheet, mapHeaders, FIELDS };
