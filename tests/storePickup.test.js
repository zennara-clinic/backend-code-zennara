const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveListing, visibleAt, priceAt, visibleAtFilter, presentForCentre, normaliseListings, listingSummary,
} = require('../utils/productCentre');
const F = require('../utils/orderFulfilment');
const { clinicHoursLine } = require('../utils/centreHours');
const { minOrderValueFor, belowMinimumMessage, PICKUP_MIN_ORDER_VALUE, MIN_ORDER_VALUE } = require('../utils/orderPricing');
const ProductOrder = require('../models/ProductOrder');

/*
 * Centre-wise products and store pickup, pinned at the rules layer: how a
 * listing resolves per centre, which status ladder an order follows, what a
 * guest may cancel, how a pickup order validates, and the pricing floors.
 */

const JH = '68f0bd7349af87d33d2b20d9';
const FD = '68f0bd7349af87d33d2b20da';
const KD = '68f0bd7349af87d33d2b20db';
const clinics = [{ _id: JH, name: 'Jubilee Hills' }, { _id: FD, name: 'Financial District' }, { _id: KD, name: 'Kondapur' }];

test('listing: no row for a centre means visible, base price, collectable', () => {
  const p = { price: 1200, centreListings: [] };
  assert.deepEqual(resolveListing(p, JH), { visible: true, price: 1200, basePrice: 1200, centrePrice: null, pickup: true, listed: false });
  assert.equal(visibleAt(p, null), true);
  assert.equal(priceAt(p, KD), 1200);
});

test('listing: a centre row hides, reprices and withholds pickup for that centre only', () => {
  const p = { price: 1200, centreListings: [
    { branchId: FD, visible: false },
    { branchId: KD, visible: true, price: 999, pickup: false },
  ] };
  assert.equal(visibleAt(p, JH), true);
  assert.equal(visibleAt(p, FD), false);
  assert.equal(priceAt(p, KD), 999);
  assert.equal(resolveListing(p, KD).pickup, false);
  assert.equal(resolveListing(p, KD).centrePrice, 999);
  assert.equal(resolveListing(p, JH).centrePrice, null);
  assert.equal(listingSummary(p, clinics), 'Jubilee Hills, Kondapur only');
});

test('listing: a zero centre price is a real price, a blank one is the base price', () => {
  assert.equal(priceAt({ price: 500, centreListings: [{ branchId: JH, price: 0 }] }, JH), 0);
  assert.equal(priceAt({ price: 500, centreListings: [{ branchId: JH, price: '' }] }, JH), 500);
  assert.equal(priceAt({ price: 500, centreListings: [{ branchId: JH, price: null }] }, JH), 500);
});

test('listing: the shop filter excludes only an explicit hide; no centre = no filter', () => {
  assert.deepEqual(visibleAtFilter(null), {});
  assert.deepEqual(visibleAtFilter(JH), { centreListings: { $not: { $elemMatch: { branchId: JH, visible: false } } } });
});

test('listing: presented for a centre, the app sees the centre price and never the rows', () => {
  const p = { name: 'Serum', price: 1200, centreListings: [{ branchId: JH, price: 1000 }] };
  const out = presentForCentre(p, JH);
  assert.equal(out.price, 1000);
  assert.equal(out.basePrice, 1200);
  assert.equal(out.centrePrice, 1000);
  assert.equal(out.pickupAvailable, true);
  assert.equal(out.centreListings, undefined);
  assert.equal(presentForCentre(p, null).price, 1200);
});

test('listing: panel rows are normalised — clinics only, one per centre, blank price = base', () => {
  const allowed = new Map(clinics.map((c) => [c._id, { name: c.name }]));
  const rows = normaliseListings([
    { branchId: JH, visible: 'false', price: '  ' },
    { branchId: JH, visible: true, price: '850.5', pickup: 'false' },   // later row wins
    { branchId: 'deadbeefdeadbeefdeadbeef', visible: false },           // a pharmacy id: dropped
    { branchId: FD, price: -5 },                                        // bad price: base
  ], allowed);
  assert.deepEqual(rows, [
    { branchId: JH, branchName: 'Jubilee Hills', visible: true, price: 850.5, pickup: false },
    { branchId: FD, branchName: 'Financial District', visible: true, price: null, pickup: true },
  ]);
});

test('fulfilment: ladders, only-statuses and what counts as fulfilled', () => {
  const delivery = { fulfilment: { type: 'delivery' } };
  const pickup = { fulfilment: { type: 'pickup', branchName: 'Kondapur' } };
  const legacy = {};
  assert.equal(F.typeOf(legacy), 'delivery');
  assert.deepEqual([...F.sequenceFor(delivery)], ['Order Placed', 'Confirmed', 'Processing', 'Packed', 'Shipped', 'Out for Delivery', 'Delivered']);
  assert.deepEqual([...F.sequenceFor(pickup)], ['Order Placed', 'Confirmed', 'Processing', 'Packed', 'Ready for Pickup', 'Collected']);
  assert.equal(F.isFulfilled('Collected'), true);
  assert.equal(F.isFulfilled('Delivered'), true);
  assert.equal(F.isFulfilled('Ready for Pickup'), false);
  assert.match(F.statusMismatch(pickup, 'Shipped'), /never shipped/);
  assert.match(F.statusMismatch(pickup, 'Delivered'), /Kondapur/);
  assert.match(F.statusMismatch(delivery, 'Collected'), /store-pickup/);
  assert.equal(F.statusMismatch(pickup, 'Ready for Pickup'), null);
  assert.equal(F.statusMismatch(delivery, 'Shipped'), null);
});

test('fulfilment: a guest may cancel a pickup order until it is collected', () => {
  assert.deepEqual(F.customerCancellable({ fulfilment: { type: 'pickup' } }), ['Order Placed', 'Confirmed', 'Processing', 'Packed', 'Ready for Pickup']);
  assert.deepEqual(F.customerCancellable({}), ['Order Placed', 'Confirmed', 'Processing', 'Packed', 'Delivery Failed']);
  assert.equal(F.fulfilledAt({ fulfilment: { collectedAt: new Date('2026-09-13T10:00:00Z') }, deliveredAt: null }).toISOString(), '2026-09-13T10:00:00.000Z');
});

test('fulfilment: pickup codes are six unambiguous characters', () => {
  for (let i = 0; i < 200; i += 1) {
    const code = F.generatePickupCode();
    assert.match(code, /^[ABCDEFGHJKMNPQRTUVWXYZ234679]{6}$/);
  }
  assert.equal(F.normalisePickupCode(' ab-c2 3x '), 'ABC23X');
  assert.equal(F.generatePickupCode(() => 0), 'AAAAAA');
});

test('fulfilment: the destination line names the centre for pickup and the street for delivery', () => {
  assert.equal(F.destinationLine({ fulfilment: { type: 'pickup', branchName: 'Kondapur', pickupAddress: { addressLine1: 'Plot 5, Road 2', city: 'Hyderabad' } } }), 'Collect at Kondapur, Plot 5, Road 2, Hyderabad');
  assert.equal(F.destinationLine({ shippingAddress: { addressLine1: '12 Lake View', city: 'Hyderabad', state: 'Telangana', postalCode: '500033' } }), '12 Lake View, Hyderabad, Telangana - 500033');
});

test('order model: pickup orders need no shipping address, delivery orders still do', () => {
  const base = { userId: '64b000000000000000000001', orderNumber: 'T1', items: [{ productId: '64b000000000000000000002', quantity: 1, price: 100, subtotal: 100 }], pricing: { subtotal: 100, total: 100 }, paymentMethod: 'Razorpay' };
  const pickup = new ProductOrder({ ...base, fulfilment: { type: 'pickup', branchId: JH, branchName: 'Jubilee Hills', pickupCode: 'abc234' } });
  assert.equal(pickup.validateSync(), undefined);
  assert.equal(pickup.fulfilment.pickupCode, 'ABC234', 'codes are stored upper-case');
  const delivery = new ProductOrder({ ...base });
  const err = delivery.validateSync();
  assert.ok(err && err.errors['shippingAddress.fullName'], 'a delivery order without an address must fail');
  const statuses = ProductOrder.schema.path('orderStatus').enumValues;
  assert.ok(statuses.includes('Ready for Pickup') && statuses.includes('Collected'));
});

test('pricing: pickup has its own floor and its own message', () => {
  assert.equal(minOrderValueFor('delivery'), MIN_ORDER_VALUE);
  assert.equal(minOrderValueFor('pickup'), PICKUP_MIN_ORDER_VALUE);
  assert.match(belowMinimumMessage(200, 'delivery'), /Minimum order value is/);
  assert.match(belowMinimumMessage(200, 'pickup'), /store pickup/);
});

test('centre hours fold into one readable line', () => {
  const hours = {};
  for (const d of ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']) hours[d] = { isOpen: true, openTime: '11:00', closeTime: '18:00' };
  hours.sunday = { isOpen: true, openTime: '11:00', closeTime: '15:00' };
  assert.equal(clinicHoursLine({ operatingHours: hours }), 'Mon–Sat 11:00–18:00 · Sun 11:00–15:00');
  hours.sunday = { isOpen: false };
  assert.equal(clinicHoursLine({ operatingHours: hours }), 'Mon–Sat 11:00–18:00 · Sun closed');
  assert.equal(clinicHoursLine({}), null);
});
