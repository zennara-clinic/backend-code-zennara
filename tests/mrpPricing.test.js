/*
 * A product's price is its MRP — final, every tax included (2026-09-28).
 * Checkout charges it as it stands; GST is never added on top; `mrp` and
 * `price` are one number.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const Product = require('../models/Product');
const { computeOrderPricing } = require('../utils/orderPricing');

const JH = '64b0000000000000000000a1';
const KD = '64b0000000000000000000a2';
const productRow = (extra = {}) => ({
  _id: '64b000000000000000000002', name: 'FCL B-Prox 10 Wash', price: 1225, gstPercentage: 18,
  isActive: true, isRx: false, trackStock: true, stock: 100, centreListings: [], ...extra,
});

async function priced(product, params) {
  const orig = Product.findById;
  Product.findById = async () => product;
  try { return await computeOrderPricing(params); } finally { Product.findById = orig; }
}

test('checkout charges the MRP as it stands: no GST on top, even at 18%', async () => {
  const r = await priced(productRow(), { items: [{ productId: 'x', quantity: 2 }], city: 'Hyderabad' });
  assert.equal(r.ok, true);
  assert.equal(r.pricing.subtotal, 2450);
  assert.equal(r.pricing.gst, 0);
  assert.equal(r.pricing.total, 2450 + r.pricing.deliveryFee);
});

test('store pickup pays exactly the MRP', async () => {
  const r = await priced(productRow(), { items: [{ productId: 'x', quantity: 1 }], fulfilment: 'pickup', branch: { _id: JH, name: 'Jubilee Hills' } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.pricing, { subtotal: 1225, gst: 0, discount: 0, deliveryFee: 0, total: 1225 });
});

test('a centre price below the MRP is what that centre charges, and nothing is added to it', async () => {
  const p = productRow({ centreListings: [{ branchId: KD, visible: true, price: 999, pickup: true }] });
  const r = await priced(p, { items: [{ productId: 'x', quantity: 1 }], fulfilment: 'pickup', branch: { _id: KD, name: 'Kondapur' } });
  assert.equal(r.pricing.total, 999);
  assert.equal(r.pricing.gst, 0);
});

const base = { name: 'Serum', description: 'd', formulation: 'Serum', OrgName: 'Zennara' };

test('a new product: mrp is the price, GST defaults to 18', async () => {
  const p = new Product({ ...base, price: 1225 });
  await p.validate();
  assert.equal(p.mrp, 1225);
  assert.equal(p.gstPercentage, 18);
});

test('price and mrp stay one number, whichever a writer changed', async () => {
  const stored = { _id: '64b000000000000000000009', ...base, price: 1000, mrp: 1000, gstPercentage: 18, stock: 5 };
  const a = Product.hydrate(stored);
  a.price = 1100;
  await a.validate();
  assert.equal(a.mrp, 1100);
  const b = Product.hydrate(stored);
  b.mrp = 1200; // an older client or sheet that sends only the MRP
  await b.validate();
  assert.equal(b.price, 1200);
  const c = Product.hydrate({ ...stored, mrp: 4499 }); // a row saved before the change, MRP above the price
  c.stock = 6;
  await c.validate();
  assert.equal(c.mrp, 1000);
  assert.equal(c.price, 1000);
});

test('a product created with only an MRP takes it as its price', async () => {
  const p = new Product({ ...base, mrp: 450 });
  await p.validate();
  assert.equal(p.price, 450);
});
