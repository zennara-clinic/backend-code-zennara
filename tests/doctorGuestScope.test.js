const test = require('node:test');
const assert = require('node:assert');
const scope = require('../utils/doctorGuestScope');

/**
 * The guards that do not need the database: who they apply to, and what a
 * dermatologist is refused before any lookup happens. The ownership lookups
 * themselves reuse doctorBookingMatch, pinned in doctorPatients.test.js.
 */

const res = () => {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
};
const run = async (mw, req) => {
  const r = res();
  let nexted = false;
  await mw(req, r, () => { nexted = true; });
  return { nexted, status: r.statusCode, body: r.body };
};

const doctor = (extra = {}) => ({ admin: { role: 'doctor', _id: 'x' }, query: {}, params: {}, body: {}, ...extra });
const adminReq = (extra = {}) => ({ admin: { role: 'super_admin', _id: 'y' }, query: {}, params: {}, body: {}, ...extra });

test('every guard is a no-op for non-dermatologist logins', async () => {
  for (const mw of [
    scope.notForDoctors,
    scope.scopedList(),
    scope.ownGuest((req) => req.params.id),
    scope.ownBooking((req) => req.params.id),
    scope.ownGuestIfNamed('userId'),
    scope.attachMyGuestIds(),
  ]) {
    const out = await run(mw, adminReq({ params: { id: '64b000000000000000000001' }, query: { userId: '64b000000000000000000001' } }));
    assert.strictEqual(out.nexted, true);
  }
  const therapist = await run(scope.notForDoctors, { admin: { role: 'therapist' } });
  assert.strictEqual(therapist.nexted, true);
});

test('a dermatologist is refused clinic-wide endpoints', async () => {
  const out = await run(scope.notForDoctors, doctor());
  assert.strictEqual(out.nexted, false);
  assert.strictEqual(out.status, 403);
  assert.strictEqual(out.body.code, 'NOT_FOR_DERMATOLOGISTS');
});

test('a dermatologist cannot read an unnarrowed list of every guest', async () => {
  const out = await run(scope.scopedList(), doctor());
  assert.strictEqual(out.nexted, false);
  assert.strictEqual(out.status, 403);
  assert.strictEqual(out.body.code, 'NOT_YOUR_PATIENT');
});

test('a malformed guest id is refused without a lookup', async () => {
  const listed = await run(scope.scopedList(), doctor({ query: { userId: 'not-an-id' } }));
  assert.strictEqual(listed.status, 403);
  const named = await run(scope.ownGuestIfNamed('userId'), doctor({ query: { userId: '{"$ne":null}' } }));
  assert.strictEqual(named.status, 403);
  const missing = await run(scope.ownGuest((req) => req.params.id), doctor());
  assert.strictEqual(missing.status, 400);
});

test('an unnamed optional guest filter passes through to the diary scope', async () => {
  const out = await run(scope.ownGuestIfNamed('userId'), doctor());
  assert.strictEqual(out.nexted, true);
});
