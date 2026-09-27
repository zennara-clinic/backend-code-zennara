const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { OTHER_SHOP, refuse } = require('../scripts/importProductImages');
const { openingStock, DEFAULT_OPENING_STOCK } = require('../utils/productStock');

/*
 * The gate a product photograph passes before it is published, and the stock a
 * product starts with. Both are rules a guest sees the result of, so both are
 * pinned.
 */

const file = Buffer.from('a photograph');
const sha = crypto.createHash('sha256').update(file).digest('hex');
const passed = { ocr: 'clean', review: 'accept', sha256: sha };

test('gate: a photograph needs a clean read, an accepted review and the same bytes', () => {
  assert.equal(refuse(passed, file), null);
  assert.match(refuse({ ...passed, ocr: 'names-shop' }, file), /another shop/);
  assert.match(refuse({ ...passed, review: 'reject', reviewReason: 'retailer sticker' }, file), /retailer sticker/);
  assert.match(refuse({ ...passed, review: undefined }, file), /visual review/);
});

test('gate: a file swapped after review is refused', () => {
  assert.match(refuse(passed, Buffer.from('a different photograph')), /changed since/);
  assert.match(refuse({ ...passed, sha256: undefined }, file), /changed since/);
});

test('gate: every way OCR returns the other shop\'s name is caught', () => {
  for (const text of ['AGELESS RS.825.00', 'AgeLess | Shop', 'Age Less', 'age-less.shop', 'A G E L E S S', 'AGEL3SS', 'AGE1ESS', 'xGELESS 501394']) {
    assert.ok(OTHER_SHOP.test(text), text);
  }
});

test('gate: packaging that merely sounds similar is not refused', () => {
  for (const text of ['Anti-ageing serum 30 ml', 'Timeless beauty', 'Paraben free, fragrance free', 'Use regardless of age', 'Dosage: 1 tablet']) {
    assert.equal(OTHER_SHOP.test(text), false, text);
  }
});

test('stock: a product nobody has counted starts at the default; a number entered is kept', () => {
  assert.equal(DEFAULT_OPENING_STOCK, 100);
  assert.equal(openingStock(undefined), 100);
  assert.equal(openingStock(''), 100);
  assert.equal(openingStock(null), 100);
  assert.equal(openingStock(12), 12);
  assert.equal(openingStock('7'), 7);
  // Zero typed on purpose means sold out, not "use the default".
  assert.equal(openingStock(0), 0);
  assert.equal(openingStock('0'), 0);
});
