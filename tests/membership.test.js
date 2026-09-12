const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const pricing = require('../utils/zenMembership');
const write = require('../services/zenotiWriteService');
const zenoti = require('../services/zenotiService');

/*
 * The Zen membership's price lived in four places (App Studio priceInr, the
 * plan row, the Zenoti catalogue, a 135000 literal) that only agreed by
 * accident. resolveZenPricing() is now the one authority; these tests pin its
 * fallback order without touching the database or Zenoti (deps are injected).
 */
const MVPJH = { id: 'prod-mvpjh', versionId: '2fca698c-8ffa-4a8f-85fd-b2c225518dc6', name: 'MVP Jh', code: 'MVPJH', price: { sales: 114407, tax: 20593, final: 135000 }, isActive: false, durationMonths: 0 };
const OTHER = { id: 'prod-ess', versionId: 'v-ess', name: 'Zennara Essential – 20% OFF', code: 'ESS', price: { final: 25000 }, isActive: true };

function stub({ membership = {}, rows = [MVPJH, OTHER], configured = true, catalogThrows = false } = {}) {
  const calls = { catalog: 0, forget: 0 };
  pricing._deps.settings = async () => ({ membership });
  pricing._deps.catalog = async () => { calls.catalog += 1; if (catalogThrows) throw new Error('Zenoti 503'); return rows; };
  pricing._deps.configured = () => configured;
  pricing._deps.forgetCatalog = () => { calls.forget += 1; };
  pricing.resetPricingCache();
  return calls;
}

test('the live Zenoti list price is charged when the card points at a catalogue row', async () => {
  stub({ membership: { priceInr: 99000, zenotiMembershipVersionId: MVPJH.versionId, durationMonths: 12, name: '', benefits: [{ title: '15% off', copy: 'on services' }] } });
  const p = await pricing.resolveZenPricing();
  assert.equal(p.amount, 135000);
  assert.equal(p.source, 'zenoti');
  assert.equal(p.zenotiListPrice, 135000);
  assert.equal(p.zenotiName, 'MVP Jh');
  assert.equal(p.zenotiCode, 'MVPJH');
  assert.equal(p.zenotiIsActive, false);
  // Zenoti says 0 months for this membership; validity stays App Studio's.
  assert.equal(p.validityMonths, 12);
  assert.equal(p.name, 'Zen Membership');
  assert.deepEqual(p.benefits, [{ title: '15% off', copy: 'on services' }]);
});

test('the row is found by product id too, and priceSource manual keeps App Studio in charge', async () => {
  stub({ membership: { priceInr: 99000, zenotiMembershipVersionId: 'PROD-MVPJH' } });
  assert.equal((await pricing.resolveZenPricing()).amount, 135000);

  stub({ membership: { priceInr: 99000, priceSource: 'manual', zenotiMembershipVersionId: MVPJH.versionId } });
  const p = await pricing.resolveZenPricing();
  assert.equal(p.amount, 99000);
  assert.equal(p.source, 'manual');
});

test('no version id, Zenoti not configured, a failed read or a zero price all fall back to priceInr and never throw', async () => {
  stub({ membership: { priceInr: 99000 } });
  assert.equal((await pricing.resolveZenPricing()).source, 'manual');

  stub({ membership: { priceInr: 99000, zenotiMembershipVersionId: MVPJH.versionId }, configured: false });
  assert.equal((await pricing.resolveZenPricing()).amount, 99000);

  stub({ membership: { priceInr: 99000, zenotiMembershipVersionId: MVPJH.versionId }, catalogThrows: true });
  const failed = await pricing.resolveZenPricing();
  assert.equal(failed.amount, 99000);
  assert.equal(failed.source, 'manual');

  stub({ membership: { priceInr: 99000, zenotiMembershipVersionId: MVPJH.versionId }, rows: [{ ...MVPJH, price: { final: 0 } }] });
  const zero = await pricing.resolveZenPricing();
  assert.equal(zero.amount, 99000);
  assert.equal(zero.source, 'manual');
  assert.equal(zero.zenotiName, 'MVP Jh', 'the row is still reported so the panel can see the misconfiguration');

  // A settings read that blows up still yields the bundled fallback.
  pricing._deps.settings = async () => { throw new Error('db down'); };
  pricing.resetPricingCache();
  const noDb = await pricing.resolveZenPricing();
  assert.equal(noDb.amount, pricing.FALLBACK_PRICE_INR);
  assert.equal(noDb.source, 'manual');
});

test('the figure is cached for five minutes so card, panel and charge agree; fresh bypasses and drops the catalogue cache', async () => {
  const calls = stub({ membership: { zenotiMembershipVersionId: MVPJH.versionId } });
  const a = await pricing.resolveZenPricing();
  const b = await pricing.resolveZenPricing();
  assert.equal(a, b);
  assert.equal(calls.catalog, 1);
  const c = await pricing.resolveZenPricing({ fresh: true });
  assert.notEqual(a, c);
  assert.equal(calls.catalog, 2);
  assert.equal(calls.forget, 1);
});

test('pricingSummary strips the copy so the plan list carries only the figures', async () => {
  stub({ membership: { zenotiMembershipVersionId: MVPJH.versionId, tagline: 'x', benefits: [{ title: 't' }] } });
  const s = pricing.pricingSummary(await pricing.resolveZenPricing());
  for (const k of ['name', 'tagline', 'description', 'benefits', 'terms', 'image', 'ctaText']) assert.equal(k in s, false, `${k} must not be in the summary`);
  assert.equal(s.amount, 135000);
  assert.equal(s.source, 'zenoti');
});

/*
 * The Zenoti sale is three calls; the payload shapes were verified live on
 * 2026-09-12 and the legacy CreateInvoice route (200 with an Error envelope)
 * must never come back.
 */
test('a membership sale is three Zenoti payloads in the verified shapes', () => {
  const plan = write.membershipSalePlan({ guestId: 'guest-1', versionId: MVPJH.versionId, centerId: 'c9f032b2-4450-4a77-8ec8-641a26908d39', amount: 135000, customPaymentId: 'pay-razorpay', closedById: 'emp-1' });
  assert.deepEqual(plan.invoice, { center_id: 'c9f032b2-4450-4a77-8ec8-641a26908d39', user_id: 'guest-1', membership_version_ids: [MVPJH.versionId] });
  assert.deepEqual(plan.payment, { custom_payment_id: 'pay-razorpay', amount: 135000 });
  assert.deepEqual(plan.close, { closed_by_id: 'emp-1' });
  assert.deepEqual(write.membershipSaleOutcome(plan, { paid: true, closed: true }), { status: 'synced', error: null });
  // Paid but the close call did not happen → still open.
  assert.equal(write.membershipSaleOutcome(plan, { paid: true, closed: false }).status, 'invoice_open');
});

test('without a payment type or closing employee the invoice is left open and the row says what to configure', () => {
  const plan = write.membershipSalePlan({ guestId: 'guest-1', versionId: MVPJH.versionId, centerId: 'c', amount: 120000 });
  assert.equal(plan.payment, null);
  assert.equal(plan.close, null);
  const out = write.membershipSaleOutcome(plan, { paid: false, closed: false });
  assert.equal(out.status, 'invoice_open');
  assert.match(out.error, /Invoice created in Zenoti but left open/);
  assert.match(out.error, /no custom payment type \/ no closing employee/);
  assert.match(out.error, /App Studio → Membership/);
  // Only the payment configured: the close is what is missing.
  const half = write.membershipSalePlan({ guestId: 'g', versionId: 'v', centerId: 'c', amount: 1, customPaymentId: 'p' });
  assert.match(write.membershipSaleOutcome(half, { paid: true }).error, /no closing employee/);
});

test('syncMembership sells through /v1/invoices/memberships, pays, closes, and never uses the legacy route', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/zenotiWriteService.js'), 'utf8');
  const i = src.indexOf('async function syncMembership(');
  const block = src.slice(i, src.indexOf('async function syncPackageAssignment('));
  assert.ok(i > -1);
  assert.match(block, /\/v1\/invoices\/memberships/);
  assert.match(block, /\/payment\/custom/);
  assert.match(block, /\/close`/);
  // The legacy route may be NAMED in the explanatory comment, never CALLED.
  assert.doesNotMatch(src, /request\(['"`]\/api\/Catalog\/Memberships\/CreateInvoice/, 'the legacy route answers 200 with an Error envelope');
  // Dryrun logs all three payloads and marks the row dryrun.
  assert.match(block, /logWrite\('createMembershipInvoice'/);
  assert.match(block, /logWrite\('addMembershipPayment'/);
  assert.match(block, /logWrite\('closeMembershipInvoice'/);
  assert.match(block, /finish\('dryrun'/);
  // The invoice id is saved before the payment step so a retry cannot invoice twice.
  assert.ok(block.indexOf('assignment.zenotiInvoiceId = String(invoiceId)') < block.indexOf('/payment/custom'));
  assert.match(block, /zenotiPaymentPostedAt/);
});

test('every sale made here — app, desk, bill line — is pushed to Zenoti, and a mirrored row never is', () => {
  const src = fs.readFileSync(path.join(__dirname, '../controllers/membershipController.js'), 'utf8');
  const i = src.indexOf('async function createMemberAssignment(');
  const block = src.slice(i, src.indexOf('exports.createMemberAssignment'));
  assert.match(block, /if \(source !== 'zenoti'\)/);
  assert.match(block, /syncMembership\(user\._id, \{ assignmentId: pa\._id \}\)/);
  // The payment path charges the resolver, not priceInr.
  const pay = fs.readFileSync(path.join(__dirname, '../controllers/paymentController.js'), 'utf8');
  const j = pay.indexOf('exports.createMembershipPayment');
  const payBlock = pay.slice(j, pay.indexOf('exports.verifyMembershipPayment'));
  assert.match(payBlock, /resolveZenPricing\(\)/);
  assert.doesNotMatch(payBlock, /membership\?\.priceInr|membership\.priceInr/);
});

test('the sold membership is matched back by invoice, else the newest Zen-family row', () => {
  const rows = [
    { id: 'um-old', name: 'MVP', invoice: { id: 'inv-old', number: 'JH100' }, memberSince: '2025-01-01', expiryDate: '2026-01-01' },
    { id: 'um-new', name: 'MVP Jh', invoice: { id: 'INV-NEW', number: 'JH200' }, memberSince: '2026-09-12', expiryDate: '2027-09-12' },
    { id: 'um-ess', name: 'Zennara Essential – 20% OFF', invoice: { id: 'inv-x', number: 'JH300' }, memberSince: '2026-09-12', expiryDate: '2028-01-01' },
  ];
  assert.equal(write.pickSoldMembership(rows, { invoiceId: 'inv-new' }).id, 'um-new');
  assert.equal(write.pickSoldMembership(rows, { invoiceNumber: 'JH100' }).id, 'um-old');
  assert.equal(write.pickSoldMembership(rows, { invoiceId: 'nope' }).id, 'um-new', 'newest Zen row, never the Essential tier');
  assert.equal(write.pickSoldMembership([rows[2]], {}), null);
});

test('the guest membership normaliser carries the agreement terms and rupee credit for the member screen', () => {
  const m = zenoti.normalizeMembership({
    user_membership_id: 'um-1', status: 1, expiry_date: '2027-01-01', membership: { name: 'MVP Jh', code: 'MVPJH' },
    terms_and_conditions: 'No refunds after 7 days.', credit_amount: 50000, credit_balance: { total: 3 }, redeemable: true,
    services: [{ service: { name: 'Hydrafacial' }, total: 4, used: 1, balance: 3 }],
  });
  assert.equal(m.terms, 'No refunds after 7 days.');
  assert.equal(m.creditAmount, 50000);
  assert.equal(m.creditBalance, 3);
  // The existing fields did not move.
  assert.equal(m.id, 'um-1');
  assert.equal(m.services[0].balance, 3);
});

test('the member screen picks the redeemable Zen row and maps it; other tiers are ignored', () => {
  const { liveMembershipView } = require('../controllers/membershipController');
  const rows = [
    { id: 'a', name: 'Zennara Prime – 30% OFF', status: 1, redeemable: true, expiryDate: '2099-01-01', services: [] },
    { id: 'b', name: 'MVP', code: 'MVP', status: 5, redeemable: false, expiryDate: '2025-01-01', services: [], invoice: { number: 'JH1' } },
    { id: 'c', name: 'MVP Jh', code: 'MVPJH', status: 1, redeemable: true, memberSince: '2026-09-12', expiryDate: '2027-09-12', invoice: { number: 'JH2' },
      creditBalance: 3, creditAmount: 50000, guestPassTotal: 2, guestPassBalance: 1, terms: 'T&C', htmlBenefits: '<p>x</p>', centerName: 'Jubilee Hills',
      services: [{ name: 'Hydrafacial', total: 4, used: 1, balance: 3, expiryDate: null }], products: [] },
  ];
  const v = liveMembershipView(rows, new Date('2026-09-12T00:00:00Z'));
  assert.equal(v.status, 'Active');
  assert.equal(v.invoiceNumber, 'JH2');
  assert.equal(v.creditAmount, 50000);
  assert.equal(v.guestPassBalance, 1);
  assert.equal(v.terms, 'T&C');
  assert.deepEqual(v.services, [{ name: 'Hydrafacial', total: 4, used: 1, balance: 3, expiryDate: null }]);
  assert.equal(v.centerName, 'Jubilee Hills');
  // Only an expired row left → Expired, latest by expiry.
  assert.equal(liveMembershipView([rows[1]], new Date('2026-09-12T00:00:00Z')).status, 'Expired');
  assert.equal(liveMembershipView([rows[0]]), null);
});

test('the catalogue normaliser exposes code, is_active, duration, benefits and terms and the cache can be dropped', () => {
  const src = fs.readFileSync(path.join(__dirname, '../services/zenotiService.js'), 'utf8');
  const i = src.indexOf('async function getCenterMemberships(');
  const block = src.slice(i, src.indexOf('async function getCenterTherapists('));
  for (const k of ["code: pick(m, 'code', 'Code')", 'isActive:', 'durationMonths:', 'htmlBenefits: m.html_benefits', 'terms: m.terms_and_conditions']) assert.ok(block.includes(k), `missing ${k}`);
  assert.equal(typeof zenoti.forgetCatalog, 'function');
  zenoti.forgetCatalog('memberships:');
});
