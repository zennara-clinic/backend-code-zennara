const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { parseAppStockWorkbook, templateDiff, buildTemplateWorkbook, toTemplateRows, TEMPLATE_HEADERS } = require('../utils/appStockTemplate');

const sheetsOf = (buf) => { const wb = XLSX.read(buf, { type: 'buffer' }); return wb.SheetNames.map((n) => ({ name: n, rows: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '' }) })); };

const stored = {
  name: 'Alopel Shampoo', code: 'ALOPSHA', productCategory: 'Haircare', formulation: 'Hair Fall & Growth', brand: 'Zennara',
  batchTracking: 'Non Batchable', consumptionOrder: 'FIFO', stock: 2, reorderLevel: 5, targetLevel: 20, packName: 'btl', packSize: '1',
  buyingPrice: 2000, price: 3999, gstPercentage: 18, vendorName: null, templateStatus: 'estimated',
};

test('a row that restates the stored product changes nothing', () => {
  const [sheet] = parseAppStockWorkbook(sheetsOf(buildTemplateWorkbook({ title: 't', note: 'n', rows: toTemplateRows([stored]) })));
  assert.equal(sheet.kind, 'template');
  assert.equal(sheet.rows.length, 1);
  assert.deepEqual(templateDiff(stored, sheet.rows[0]), []);
});

test('only fields that really differ are reported', () => {
  const row = { ...parseAppStockWorkbook(sheetsOf(buildTemplateWorkbook({ title: 't', note: 'n', rows: toTemplateRows([stored]) })))[0].rows[0], stock: 9, price: 4200, vendorName: 'Sai Pharma' };
  assert.deepEqual(templateDiff(stored, row), ['stock', 'selling price', 'vendor']);
});

test('blank template has headings and no products; the import one carries the guide', () => {
  const imp = sheetsOf(buildTemplateWorkbook({ title: 't', note: 'n', guide: true }));
  assert.deepEqual(imp.map((s) => s.name), ['Stock_Import_Template', 'How to fill']);
  assert.deepEqual(imp[0].rows[2], TEMPLATE_HEADERS);
  assert.equal(parseAppStockWorkbook(imp)[0].rows.length, 0);
  assert.deepEqual(sheetsOf(buildTemplateWorkbook({ title: 't', note: 'n' })).map((s) => s.name), ['Stock_Import_Template']);
});

test('headers-only sheet without banner rows (as the pharmacy sends it) still parses', () => {
  const ws = XLSX.utils.aoa_to_sheet([TEMPLATE_HEADERS.slice(0, 17), ['New Serum', 'Skincare', 'NEW001', 'Serum', 'X', '', '', 4, '', '', '', '', 100, 499, 18, '', '']]);
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const [sheet] = parseAppStockWorkbook(sheetsOf(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })));
  assert.equal(sheet.rows[0].code, 'NEW001');
  assert.equal(sheet.rows[0].price, 499);
});

test('unknown codes become new products only with name, code and price', async () => {
  const Product = require('../models/Product');
  const orig = Product.find;
  Product.find = () => ({ select: () => ({ lean: async () => [{ _id: 'p1', ...stored }] }) });
  try {
    const ctrl = require('../controllers/adminProductController');
    const sheets = [{ kind: 'template', sheetName: 'Sheet1', rows: [
      { ...stored, code: 'ALOPSHA', stock: 2, price: 3999, gst: 18 },
      { name: 'New Serum', code: 'NEW001', price: 499, stock: 4 },
      { name: 'New Serum again', code: 'new001', price: 520, stock: 1 },
      { name: 'No price', code: 'NEW002', price: null },
    ] }];
    const { plan, unmatched, creates } = await ctrl.matchTemplateRows(sheets);
    assert.equal(plan.size, 1);
    assert.equal(creates.length, 1);
    assert.equal(creates[0].price, 520);
    assert.equal(unmatched.length, 1);
    assert.match(unmatched[0], /NEW002 \(new product needs Selling Price\)/);
  } finally { Product.find = orig; }
});
