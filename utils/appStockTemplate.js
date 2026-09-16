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

const TEMPLATE_HEADERS = ['Item Name', 'Category', 'Code', 'Formulation', 'Brand', 'Batch Tracking', 'Consumption Order', 'Opening Quantity', 'Re-order Level', 'Target Level', 'Pack Name', 'Pack Size', 'Buying Price ₹', 'Selling Price ₹', 'GST %', 'Vendor', 'Status', 'Sub Category', 'HSN Code', 'MRP ₹'];

const TEMPLATE_MAP = { 'item name': 'name', category: 'category', code: 'code', formulation: 'formulation', brand: 'brand', 'batch tracking': 'batchTracking', 'consumption order': 'consumptionOrder', 'opening quantity': 'stock', 're order level': 'reorderLevel', 'target level': 'targetLevel', 'pack name': 'packName', 'pack size': 'packSize', 'buying price': 'buyingPrice', 'selling price': 'price', 'gst %': 'gst', gst: 'gst', vendor: 'vendorName', status: 'templateStatus', 'sub category': 'subCategory', 'hsn code': 'hsn', hsn: 'hsn', mrp: 'mrp' };
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
    p.productSubCategory || '', p.hsn || '', p.mrp ?? '',
  ]);
}

/**
 * What a template row would really change on a product: one label per field
 * whose value differs. A row that restates what is already stored yields [].
 */
const same = (a, b) => {
  const na = a === '' || a === undefined ? null : a; const nb = b === '' || b === undefined ? null : b;
  if (na === null || nb === null) return na === nb;
  if (typeof na === 'number' || typeof nb === 'number') return Number(na) === Number(nb);
  return String(na).trim().toLowerCase() === String(nb).trim().toLowerCase();
};
function templateDiff(p, t) {
  const out = [];
  const check = (label, next, current) => { if (next !== null && next !== undefined && next !== '' && !same(next, current)) out.push(label); };
  check('category', t.category, p.productCategory);
  check('sub category', t.subCategory, p.productSubCategory);
  check('formulation', t.formulation, p.formulation);
  check('brand', t.brand, p.brand);
  if (t.batchTracking) check('batch tracking', /non/i.test(t.batchTracking) ? 'Non Batchable' : 'Batchable', p.batchTracking);
  if (t.consumptionOrder) check('consumption order', /exp/i.test(t.consumptionOrder) ? 'ByExpiry' : 'FIFO', p.consumptionOrder);
  if (t.stock !== null) check('stock', Math.max(0, t.stock), Number(p.stock) || 0);
  check('re-order level', t.reorderLevel, p.reorderLevel);
  check('target level', t.targetLevel, p.targetLevel);
  check('pack name', t.packName, p.packName);
  check('pack size', t.packSize, p.packSize);
  check('buying price', t.buyingPrice, p.buyingPrice);
  if (t.price !== null && t.price > 0) check('selling price', t.price, p.price);
  check('GST', t.gst, p.gstPercentage);
  check('vendor', t.vendorName, p.vendorName);
  check('status', t.templateStatus, p.templateStatus);
  check('HSN', t.hsn, p.hsn);
  check('MRP', t.mrp, p.mrp);
  if (t.code && !p.code) out.push('code');
  return out;
}

/** The fields templateDiff and the import read — select these when matching. */
const TEMPLATE_SELECT = '_id name code sku isActive isAppProduct isRx image price stock productCategory productSubCategory formulation brand batchTracking consumptionOrder reorderLevel targetLevel packName packSize buyingPrice gstPercentage vendorName templateStatus hsn mrp';

const GUIDE = [
  ['Zennara product template — how to fill it in'],
  [''],
  ['Column', 'Required?', 'What to enter', 'Allowed values / format'],
  ['Item Name', 'Yes', 'Product name as it should appear in the app and on bills.', 'Free text'],
  ['Category', 'Recommended', 'Product category, spelled the way the panel spells it.', 'e.g. Skincare, Haircare, Supplements'],
  ['Code', 'Yes', 'Product code. Rows match existing products by Code, then by Item Name. A new Code creates a new product.', 'Unique, no spaces'],
  ['Formulation', 'Recommended', 'The app groups products by this.', 'e.g. Cleansing & Conditioning, Sunscreen, Serum'],
  ['Brand', 'Recommended', 'Manufacturer or brand.', 'Free text'],
  ['Batch Tracking', 'Optional', 'Whether stock is tracked by batch.', 'Batchable  or  Non Batchable'],
  ['Consumption Order', 'Optional', 'Which batch is sold first.', 'FIFO  or  ByExpiry'],
  ['Opening Quantity', 'Recommended', 'Units on hand. Becomes the stock count after import.', 'Whole number, 0 or more'],
  ['Re-order Level', 'Optional', 'Low-stock alert level.', 'Whole number'],
  ['Target Level', 'Optional', 'Level to top up to when re-ordering.', 'Whole number'],
  ['Pack Name', 'Optional', 'Pack unit.', 'e.g. btl, tube, ea, strip'],
  ['Pack Size', 'Optional', 'Quantity per pack.', 'e.g. 1, 50 g, 100 ml'],
  ['Buying Price ₹', 'Optional', 'Purchase cost per unit.', 'Number only, no ₹ or commas'],
  ['Selling Price ₹', 'Yes for new products', 'Price the guest pays, GST inclusive.', 'Number only, no ₹ or commas'],
  ['GST %', 'Recommended', 'GST rate.', '0, 5, 12, 18 or 28'],
  ['Vendor', 'Optional', 'Supplier name.', 'Free text'],
  ['Status', 'Optional', 'How sure the selling price is.', 'VPA confirmed  /  estimated  /  needs price'],
  ['Sub Category', 'Optional', 'Finer grouping inside the category.', 'Free text'],
  ['HSN Code', 'Optional', 'HSN code for GST invoices.', 'Digits'],
  ['MRP ₹', 'Optional', 'Printed MRP.', 'Number only'],
  [''],
  ['Rules'],
  ['1. Keep the header row exactly as it is. Column order does not matter; the headings do.'],
  ['2. A blank cell never clears a value that is already saved.'],
  ['3. New products are added to the Commerce catalogue hidden. Add a photo and switch them on in the panel to put them in the app.'],
  ['4. Upload at Commerce › Products › Import. The preview shows exactly what will change before anything is saved.'],
  ['5. Nothing in this file is written to Zenoti.'],
];

/**
 * An .xlsx buffer in the template shape. `rows` empty = a blank structure.
 * `guide` adds the "How to fill" sheet (the import template carries it).
 */
function buildTemplateWorkbook({ title, note, rows = [], guide = false }) {
  const XLSX = require('xlsx');
  const ws = XLSX.utils.aoa_to_sheet([[title], [note], TEMPLATE_HEADERS, ...rows]);
  ws['!cols'] = TEMPLATE_HEADERS.map((h, i) => ({ wch: i === 0 ? 36 : Math.max(12, h.length + 4) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Stock_Import_Template');
  if (guide) {
    const g = XLSX.utils.aoa_to_sheet(GUIDE);
    g['!cols'] = [{ wch: 20 }, { wch: 20 }, { wch: 80 }, { wch: 44 }];
    XLSX.utils.book_append_sheet(wb, g, 'How to fill');
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { parseAppStockWorkbook, toTemplateRows, templateDiff, buildTemplateWorkbook, TEMPLATE_HEADERS, TEMPLATE_SELECT };
