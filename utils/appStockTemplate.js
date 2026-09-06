/**
 * The App Stock template — the one import / export sheet for Commerce products.
 *
 * Three sheet shapes are understood, all produced by the pharmacy team:
 *   template  "Stock_Import_Template": Item Name · Category · Code · Formulation ·
 *             Brand · Batch Tracking · Consumption Order · Opening Quantity ·
 *             Re-order Level · Target Level · Pack Name · Pack Size · Buying Price ₹ ·
 *             Selling Price ₹ · GST % · Vendor · Status   (two banner rows above the headers)
 *   otc       "OTC_Sell_Directly":  # · Product Code · Product Name · Category · Sub Category ·
 *             Stock Qty · MRP ₹ · HSN Code · Vendor · Reason   (category divider rows inside)
 *   rx        "Rx_Prescription_Required": same columns as otc
 *
 * Export always writes the template shape, so what goes out can come back in.
 * Nothing here talks to Zenoti: products are matched to rows that already exist
 * locally and only OUR fields are written.
 */
const norm = (s) => String(s || '').toLowerCase().replace(/₹/g, '').replace(/[^a-z0-9%#]+/g, ' ').trim();
const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(String(v).replace(/[₹,\s]/g, '')); return Number.isFinite(n) ? n : null; };
const str = (v) => { const s = v === null || v === undefined ? '' : String(v).trim(); return s && s !== '—' && s !== '-' ? s : null; };

const TEMPLATE_HEADERS = ['Item Name', 'Category', 'Code', 'Formulation', 'Brand', 'Batch Tracking', 'Consumption Order', 'Opening Quantity', 'Re-order Level', 'Target Level', 'Pack Name', 'Pack Size', 'Buying Price ₹', 'Selling Price ₹', 'GST %', 'Vendor', 'Status'];

const TEMPLATE_MAP = { 'item name': 'name', category: 'category', code: 'code', formulation: 'formulation', brand: 'brand', 'batch tracking': 'batchTracking', 'consumption order': 'consumptionOrder', 'opening quantity': 'stock', 're order level': 'reorderLevel', 'target level': 'targetLevel', 'pack name': 'packName', 'pack size': 'packSize', 'buying price': 'buyingPrice', 'selling price': 'price', 'gst %': 'gst', gst: 'gst', vendor: 'vendorName', status: 'templateStatus', 'sub category': 'subCategory', 'hsn code': 'hsn', hsn: 'hsn' };
const CLASS_MAP = { '#': 'n', 'product code': 'code', 'product name': 'name', category: 'category', 'sub category': 'subCategory', 'stock qty': 'stock', 'mrp': 'mrp', 'hsn code': 'hsn', vendor: 'vendorName', reason: 'reason' };

/** Find the header row (banner rows precede it) and which shape the sheet is. */
function detect(rows) {
  for (let i = 0; i < Math.min(rows.length, 8); i += 1) {
    const cells = (rows[i] || []).map(norm);
    if (cells.includes('item name') && cells.includes('code')) return { headerRow: i, kind: 'template' };
    if (cells.includes('product code') && cells.includes('product name')) return { headerRow: i, kind: 'classification' };
  }
  return null;
}

/**
 * Parse a workbook (array of sheets as {name, rows[][]}). Returns
 * { kind, sheetName, rows: [{...fields}], skipped, headers }.
 * A classification workbook may hold both OTC and Rx sheets; each is returned.
 */
function parseAppStockWorkbook(sheets) {
  const out = [];
  for (const sheet of sheets) {
    const d = detect(sheet.rows || []);
    if (!d) continue;
    const headers = (sheet.rows[d.headerRow] || []).map(norm);
    const map = d.kind === 'template' ? TEMPLATE_MAP : CLASS_MAP;
    const fields = headers.map((h) => map[h] || Object.entries(map).find(([k]) => h.startsWith(k))?.[1] || null);
    const rxSheet = /rx|prescription/i.test(sheet.name) && d.kind === 'classification';
    const parsed = []; let skipped = 0;
    for (const raw of sheet.rows.slice(d.headerRow + 1)) {
      const r = {};
      fields.forEach((f, i) => { if (f) r[f] = raw[i]; });
      const code = str(r.code); const name = str(r.name);
      // Category divider rows ("  Haircare  ") have a name-ish first cell and nothing else.
      if (!code && !name) { skipped += 1; continue; }
      if (!code && d.kind === 'classification' && !str(r.category)) { skipped += 1; continue; }
      parsed.push({
        code, name,
        category: str(r.category), subCategory: str(r.subCategory), formulation: str(r.formulation), brand: str(r.brand),
        batchTracking: str(r.batchTracking), consumptionOrder: str(r.consumptionOrder),
        stock: num(r.stock), reorderLevel: num(r.reorderLevel), targetLevel: num(r.targetLevel),
        packName: str(r.packName), packSize: str(r.packSize),
        buyingPrice: num(r.buyingPrice), price: num(r.price), mrp: num(r.mrp), gst: num(r.gst),
        hsn: str(r.hsn), vendorName: str(r.vendorName), templateStatus: str(r.templateStatus), reason: str(r.reason),
        classification: d.kind === 'classification' ? (rxSheet ? 'rx' : 'otc') : null,
      });
    }
    out.push({ kind: d.kind, classification: d.kind === 'classification' ? (rxSheet ? 'rx' : 'otc') : null, sheetName: sheet.name, rows: parsed, skipped, headers: sheet.rows[d.headerRow] });
  }
  return out;
}

/** Rows for the export sheet, in template column order. */
function toTemplateRows(products) {
  return products.map((p) => [
    p.name || '', p.productCategory || '', p.code || p.sku || '', p.formulation || '', p.brand || p.OrgName || '',
    p.batchTracking || (p.trackStock === false ? '' : 'Non Batchable'), p.consumptionOrder || 'FIFO',
    Number.isFinite(Number(p.stock)) ? Number(p.stock) : '', p.reorderLevel ?? p.lowStockThreshold ?? '', p.targetLevel ?? '',
    p.packName || '', p.packSize || '', p.buyingPrice ?? '', p.price ?? '', p.gstPercentage ?? '', p.vendorName || '', p.templateStatus || '',
  ]);
}

module.exports = { parseAppStockWorkbook, toTemplateRows, TEMPLATE_HEADERS };
