const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Package = require('../models/Package');
const PackageAssignment = require('../models/PackageAssignment');
const rules = require('../utils/packageRules');

const oid = () => new mongoose.Types.ObjectId();
const user = (name) => ({ _id: oid(), fullName: name, email: `${name}@x.in`, phone: '9999999999', patientId: 'ZEN1', memberType: 'Regular Member' });

function pkg(over = {}) {
  return new Package({ id: 'pkg-t', name: 'Exosome 3 session', description: 'x', price: 57600, services: [
    { serviceId: 'exosome-5ml', serviceName: 'Exosome 5ml', sessions: 3, redemptionOrder: 1 },
    { serviceId: 'gfc-face', serviceName: 'GFC Face', sessions: 2, redemptionOrder: 2 },
  ], validityMonths: 6, graceDays: 30, maxFreezes: 1, ...over });
}

test('assignment copies the package terms; validity from sale + grace window', () => {
  const p = pkg();
  const pa = rules.buildAssignment(p, user('A'), { branchId: oid() });
  assert.equal(pa.terms.graceDays, 30);
  assert.equal(pa.terms.validityDays, Math.round(6 * 30.4375));
  assert.ok(pa.validUntil instanceof Date);
  const bal = pa.serviceBalances();
  assert.deepEqual(bal.map((b) => [b.serviceName, b.entitled, b.balance, b.order]), [['Exosome 5ml', 3, 3, 1], ['GFC Face', 2, 2, 2]]);
  assert.equal(pa.redeemable({}).ok, true);
});

test('never-expires and first-redemption packages have no validUntil at sale', () => {
  assert.equal(rules.buildAssignment(pkg({ neverExpires: true }), user('B')).validUntil, null);
  assert.equal(rules.buildAssignment(pkg({ validityStartsAt: 'firstRedemption' }), user('C')).validUntil, null);
});

test('redeemable() refuses frozen, expired (after grace) and wrong-centre packages', () => {
  const here = oid(); const there = oid();
  const pa = rules.buildAssignment(pkg({ redemption: { scope: 'centres', branchIds: [here] } }), user('D'), { branchId: here });
  assert.equal(pa.redeemable({ branchId: here }).ok, true);
  assert.equal(pa.redeemable({ branchId: there }).code, 'PACKAGE_WRONG_CENTRE');
  rules.freeze(pa, { by: 'desk', reason: 'travel' });
  assert.equal(pa.redeemable({ branchId: here }).code, 'PACKAGE_FROZEN');
  assert.throws(() => rules.freeze(pa), /already frozen/);
  rules.unfreeze(pa, { by: 'desk' });
  assert.equal(pa.freezeHistory.length, 1);
  assert.throws(() => rules.freeze(pa), /allows 1 freeze/);
  // expiry with grace: validUntil yesterday, graceUntil in 29 days → still redeemable (grace)
  pa.validUntil = new Date(Date.now() - 86400000); pa.graceUntil = new Date(Date.now() + 29 * 86400000);
  const r = pa.redeemable({ branchId: here }); assert.equal(r.ok, true); assert.equal(r.grace, true);
  pa.graceUntil = new Date(Date.now() - 1000);
  assert.equal(pa.redeemable({ branchId: here }).code, 'PACKAGE_EXPIRED');
});

test('unfreeze adds the frozen days back to the validity', () => {
  const pa = rules.buildAssignment(pkg(), user('E'));
  const before = new Date(pa.validUntil);
  pa.freeze = { isFrozen: true, frozenAt: new Date(Date.now() - 10 * 86400000), frozenBy: 'x', reason: null, resumeOn: null };
  rules.unfreeze(pa, { by: 'y' });
  assert.equal(Math.round((pa.validUntil - before) / 86400000), 10);
  assert.equal(pa.freezeHistory[0].days, 10);
});

test('transfer moves balance to a new assignment and shows as transferred on the source', () => {
  const pa = rules.buildAssignment(pkg(), user('F'));
  pa.sessions.push({ serviceId: 'exosome-5ml', serviceName: 'Exosome 5ml', scheduledDate: new Date(), status: 'Completed', completedAt: new Date() });
  const target = user('G');
  const created = rules.transfer(pa, target, [{ serviceId: 'exosome-5ml', qty: 1 }, { serviceId: 'gfc-face', qty: 2 }], { by: 'desk' });
  const src = pa.serviceBalances();
  assert.deepEqual(src.map((b) => [b.serviceName, b.used, b.transferred, b.balance]), [['Exosome 5ml', 1, 1, 1], ['GFC Face', 0, 2, 0]]);
  assert.deepEqual(created.serviceBalances().map((b) => [b.serviceName, b.entitled, b.balance]), [['Exosome 5ml', 1, 1], ['GFC Face', 2, 2]]);
  assert.equal(String(created.transferredFrom.assignmentId), String(pa._id));
  assert.throws(() => rules.transfer(pa, target, [{ serviceId: 'gfc-face', qty: 1 }]), /Only 0 GFC Face/);
  assert.throws(() => rules.transfer(pa, { _id: pa.userId }, [{ serviceId: 'exosome-5ml', qty: 1 }]), /different guest/);
});

test('refund suggestion prorates by unused units and refund cancels the package', () => {
  const pa = rules.buildAssignment(pkg(), user('H'), { payment: { isReceived: true, amountPaid: 50000 } });
  pa.pricing.finalAmount = 50000;
  pa.sessions.push({ serviceId: 'exosome-5ml', serviceName: 'Exosome 5ml', scheduledDate: new Date(), status: 'Completed', completedAt: new Date() });
  const s = rules.refundSuggestion(pa);
  assert.equal(s.unitsTotal, 5); assert.equal(s.unitsLeft, 4); assert.equal(s.suggested, 40000);
  assert.throws(() => rules.refund(pa, { amount: 40000, reason: '' }), /reason/);
  rules.refund(pa, { amount: 40000, method: 'UPI', reason: 'Moving abroad', by: 'desk' });
  assert.equal(pa.status, 'Cancelled'); assert.equal(pa.refund.amount, 40000);
});

test('closeWhenConsumed=false keeps a fully used package Active', () => {
  const pa = rules.buildAssignment(pkg({ closeWhenConsumed: false, services: [{ serviceId: 's1', serviceName: 'S1', sessions: 1 }] }), user('I'));
  pa.sessions.push({ serviceId: 's1', serviceName: 'S1', scheduledDate: new Date(), status: 'Completed', completedAt: new Date() });
  assert.equal(pa.checkCompletion(), false);
  assert.equal(pa.status, 'Active');
  const pb = rules.buildAssignment(pkg({ services: [{ serviceId: 's1', serviceName: 'S1', sessions: 1 }] }), user('J'));
  pb.sessions.push({ serviceId: 's1', serviceName: 'S1', scheduledDate: new Date(), status: 'Completed', completedAt: new Date() });
  assert.equal(pb.checkCompletion(), true);
});

test('package priceAt honours a centre override', () => {
  const b = oid();
  const p = pkg({ centrePrices: [{ branchId: b, price: 54857.14, taxPercent: 5 }], priceIncludesTax: false });
  assert.equal(p.priceAt(b).total, 57600);
  assert.equal(p.priceAt(oid()).price, 57600);
});
