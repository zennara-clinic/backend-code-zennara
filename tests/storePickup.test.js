const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveListing, visibleAt, priceAt, visibleAtFilter, presentForCentre, normaliseListings, listingSummary,
} = require('../utils/productCentre');
const F = require('../utils/orderFulfilment');
const { clinicHoursLine } = require('../utils/centreHours');
const { minOrderValueFor, belowMinimumMessage, PICKUP_MIN_ORDER_VALUE, MIN_ORDER_VALUE } = require('../utils/orderPricing');
const handover = require('../services/handoverCodeService');
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

test('handover: codes are six unambiguous characters', () => {
  for (let i = 0; i < 200; i += 1) {
    const code = F.generateHandoverCode();
    assert.match(code, /^[ABCDEFGHJKMNPQRTUVWXYZ234679]{6}$/);
  }
  assert.equal(F.normaliseHandoverCode(' ab-c2 3x '), 'ABC23X');
  assert.equal(F.generateHandoverCode(() => 0), 'AAAAAA');
});

test('handover: the code is issued at the right step and spent at the right one', () => {
  const pickup = { fulfilment: { type: 'pickup', branchName: 'Kondapur' } };
  const delivery = { fulfilment: { type: 'delivery' } };
  assert.equal(F.ISSUE_STATUS.pickup, 'Order Placed');
  assert.equal(F.ISSUE_STATUS.delivery, 'Out for Delivery');
  assert.equal(F.handoverStatusFor(pickup), 'Collected');
  assert.equal(F.handoverStatusFor(delivery), 'Delivered');
  assert.equal(F.handoverStatusFor({}), 'Delivered', 'a legacy order with no block is a delivery');
  assert.equal(F.isHandoverStatus(pickup, 'Collected'), true);
  assert.equal(F.isHandoverStatus(pickup, 'Ready for Pickup'), false);
  assert.equal(F.isHandoverStatus(delivery, 'Delivered'), true);
  assert.equal(F.isHandoverStatus(delivery, 'Out for Delivery'), false);
  assert.match(F.handoverAudience(pickup), /reception desk at Kondapur/);
  assert.equal(F.handoverAudience(delivery), 'the delivery partner');
});

test('handover: a code opens its own order, and nothing else does', () => {
  const order = { fulfilment: { type: 'pickup', branchName: 'Kondapur' }, handover: { code: 'ABC234' } };
  assert.deepEqual(handover.verify(order, { typed: 'abc234' }), { ok: true, method: 'code' });
  assert.deepEqual(handover.verify(order, { typed: ' abc-234 ' }), { ok: true, method: 'code' }, 'spacing and dashes are the guest reading it out');
  assert.equal(handover.verify(order, { typed: 'ABC235' }).code, 'HANDOVER_CODE_MISMATCH');
  assert.equal(handover.verify(order, { typed: '' }).code, 'HANDOVER_CODE_REQUIRED');
  assert.equal(handover.verify({ ...order, handover: {} }, { typed: 'ABC234' }).code, 'HANDOVER_CODE_MISSING');
  // An override has to say something; a blank note is not a reason.
  assert.equal(handover.verify(order, { override: true, note: '   ' }).code, 'HANDOVER_NOTE_REQUIRED');
  const ok = handover.verify(order, { override: true, note: 'phone number matched the order' });
  assert.deepEqual(ok, { ok: true, method: 'override', note: 'phone number matched the order' });
});

test('handover: a verified handover is stamped on the order', () => {
  const order = { handover: { code: 'ABC234' } };
  const at = handover.markVerified(order, { ok: true, method: 'override', note: 'showed the app' }, 'admin-1');
  assert.equal(order.handover.method, 'override');
  assert.equal(order.handover.note, 'showed the app');
  assert.equal(order.handover.verifiedBy, 'admin-1');
  assert.deepEqual(order.handover.verifiedAt, at);
  handover.markVerified(order, { ok: true, method: 'code' }, null);
  assert.equal(order.handover.note, null, 'a typed code leaves no override note behind');
});

test('fulfilment: the destination line names the centre for pickup and the street for delivery', () => {
  assert.equal(F.destinationLine({ fulfilment: { type: 'pickup', branchName: 'Kondapur', pickupAddress: { addressLine1: 'Plot 5, Road 2', city: 'Hyderabad' } } }), 'Collect at Kondapur, Plot 5, Road 2, Hyderabad');
  assert.equal(F.destinationLine({ shippingAddress: { addressLine1: '12 Lake View', city: 'Hyderabad', state: 'Telangana', postalCode: '500033' } }), '12 Lake View, Hyderabad, Telangana - 500033');
});

test('order model: pickup orders need no shipping address, delivery orders still do', () => {
  const base = { userId: '64b000000000000000000001', orderNumber: 'T1', items: [{ productId: '64b000000000000000000002', quantity: 1, price: 100, subtotal: 100 }], pricing: { subtotal: 100, total: 100 }, paymentMethod: 'Razorpay' };
  const pickup = new ProductOrder({ ...base, fulfilment: { type: 'pickup', branchId: JH, branchName: 'Jubilee Hills' }, handover: { code: 'abc234', issuedFor: 'pickup' } });
  assert.equal(pickup.validateSync(), undefined);
  assert.equal(pickup.handover.code, 'ABC234', 'codes are stored upper-case');
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

test('handover: the ready-to-collect and delivery messages carry the same code', async () => {
  const order = {
    _id: 'o1', orderNumber: 'ORD1', userId: 'u1',
    fulfilment: { type: 'pickup', branchName: 'Kondapur', pickupAddress: { addressLine1: 'Plot 5', city: 'Hyderabad', pincode: '500084', phone: '040-1234' } },
    handover: { code: 'ABC234' },
  };
  const pickupData = await handover.messageData(order, { fullName: 'Asha' });
  assert.equal(pickupData.code, 'ABC234');
  assert.equal(pickupData.fulfilment, 'pickup');
  assert.equal(pickupData.centreName, 'Kondapur');
  assert.equal(pickupData.centreAddress, 'Plot 5, Hyderabad, 500084');
  assert.match(pickupData.showTo, /reception desk at Kondapur/);
  assert.equal(pickupData.deliveryAddress, null, 'a pickup order has nowhere to deliver to');

  const delivery = {
    _id: 'o2', orderNumber: 'ORD2', userId: 'u1',
    fulfilment: { type: 'delivery' },
    shippingAddress: { fullName: 'Asha R', addressLine1: '12 Lake View', city: 'Hyderabad', postalCode: '500033' },
    deliveryPartner: 'Ravi', trackingId: 'TRK9',
    handover: { code: 'XYZ678' },
  };
  const deliveryData = await handover.messageData(delivery, { fullName: 'Asha' });
  assert.equal(deliveryData.code, 'XYZ678');
  assert.equal(deliveryData.fulfilment, 'delivery');
  assert.equal(deliveryData.showTo, 'the delivery partner');
  assert.equal(deliveryData.deliveryAddress, '12 Lake View, Hyderabad, 500033');
  assert.equal(deliveryData.deliveryPartner, 'Ravi');
  assert.equal(deliveryData.centreName, null);
  assert.equal(deliveryData.customerName, 'Asha R', 'the delivery address names the recipient');
});

test('handover: both emails and both WhatsApp messages print the code', () => {
  const template = require('../Email Templates/handoverCode');
  const pickupHtml = template('Asha', { fulfilment: 'pickup', orderNumber: 'ORD1', code: 'ABC234', centreName: 'Kondapur', centreAddress: 'Plot 5', showTo: 'the reception desk at Kondapur' });
  assert.match(pickupHtml, /ABC234/);
  assert.match(pickupHtml, /Your pickup code/);
  assert.match(pickupHtml, /Kondapur/);
  const deliveryHtml = template('Asha', { fulfilment: 'delivery', orderNumber: 'ORD2', code: 'XYZ678', deliveryAddress: '12 Lake View', showTo: 'the delivery partner' });
  assert.match(deliveryHtml, /XYZ678/);
  assert.match(deliveryHtml, /Your delivery code/);
  assert.match(deliveryHtml, /delivery partner/);
  // Whatever a guest is called, it cannot become markup in their own email.
  assert.match(template('<script>x</script>', { fulfilment: 'pickup', orderNumber: 'O', code: 'A' }), /&lt;script&gt;/);
});

test('order model: the handover block records the code, its delivery and its use', () => {
  const path = ProductOrder.schema.path('handover.method');
  assert.deepEqual(path.enumValues.filter(Boolean), ['code', 'override']);
  for (const field of ['handover.code', 'handover.issuedFor', 'handover.issuedAt', 'handover.sentAt', 'handover.sentChannels', 'handover.verifiedAt', 'handover.verifiedBy', 'handover.note']) {
    assert.ok(ProductOrder.schema.path(field), `${field} must exist`);
  }
  // The old pickup-only field is gone; one code serves both flows.
  assert.equal(ProductOrder.schema.path('fulfilment.pickupCode'), undefined);
});
