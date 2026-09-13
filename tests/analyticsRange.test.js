const test = require('node:test');
const assert = require('node:assert');
const { reportWindow } = require('../controllers/analyticsController');
const responseCache = require('../utils/responseCache');
const { addClinicDays, clinicDateKey, clinicDayEnd, clinicDayStart } = require('../utils/bookingTime');

/**
 * The one reading of the report window every analytics handler shares, and
 * the response cache in front of them. No database: reportWindow is pure, and
 * the cache middleware is exercised with hand-made req/res objects.
 *
 * Why these are pinned: the Analytics page sends its three ranges in two
 * different forms (lib/ranges.ts — startDate/endDate, an endDate alone for
 * All time, and a 2015 floor to the endpoints that used to default to 30
 * days), older callers send `days` or `from`/`to`, and every handler used to
 * read them differently — so the range flip moved some tiles and not others.
 */

const req = (query, admin) => ({ query, admin, method: 'GET', originalUrl: '/api/admin/analytics/x' });
const today = clinicDateKey(new Date());

test('This month: 1st of the clinic month to today, bounded', () => {
  const first = `${today.slice(0, 7)}-01`;
  const w = reportWindow(req({ startDate: first, endDate: today }));
  assert.strictEqual(w.openStart, false);
  assert.strictEqual(w.startKey, first);
  assert.strictEqual(w.endKey, today);
  assert.deepStrictEqual(w.start, clinicDayStart(first));
  assert.deepStrictEqual(w.end, clinicDayEnd(today));
  assert.strictEqual(w.days, Number(today.slice(8)));
});

test('Last 90 days: today and the 89 days before it', () => {
  const start = addClinicDays(today, -89);
  const w = reportWindow(req({ startDate: start, endDate: today }));
  assert.strictEqual(w.days, 90);
  assert.strictEqual(w.startKey, start);
  assert.strictEqual(w.openStart, false);
});

test('All time as the panel sends it — an endDate with no startDate — is an open start', () => {
  const w = reportWindow(req({ endDate: today }));
  assert.strictEqual(w.openStart, true);
  assert.strictEqual(w.start, null);
  assert.strictEqual(w.startKey, null);
  assert.strictEqual(w.days, null);
  assert.strictEqual(w.endKey, today);
  assert.deepStrictEqual(w.end, clinicDayEnd(today));
});

test('the 2015 floor the panel sends to bounded endpoints is an open start too', () => {
  for (const floor of ['2015-01-01', '2014-12-31', '2010-06-01']) {
    const w = reportWindow(req({ startDate: floor, endDate: today }));
    assert.strictEqual(w.openStart, true, floor);
    assert.strictEqual(w.start, null, floor);
  }
  // A day after the floor is a real start.
  const w = reportWindow(req({ startDate: '2015-01-02', endDate: today }));
  assert.strictEqual(w.openStart, false);
  assert.strictEqual(w.startKey, '2015-01-02');
});

test('legacy `days` means that many clinic days ending today', () => {
  const w = reportWindow(req({ days: '90' }));
  assert.strictEqual(w.days, 90);
  assert.strictEqual(w.startKey, addClinicDays(today, -89));
  assert.strictEqual(w.endKey, today);
  assert.strictEqual(w.openStart, false);
  // startDate/endDate win over days when both are sent (the panel sends both to /patients).
  const both = reportWindow(req({ days: '90', startDate: `${today.slice(0, 7)}-01`, endDate: today }));
  assert.strictEqual(both.startKey, `${today.slice(0, 7)}-01`);
});

test('legacy `from`/`to` (staff sales) read as startDate/endDate', () => {
  const w = reportWindow(req({ from: '2026-08-01', to: '2026-08-31' }));
  assert.strictEqual(w.startKey, '2026-08-01');
  assert.strictEqual(w.endKey, '2026-08-31');
  assert.strictEqual(w.days, 31);
  assert.strictEqual(w.openStart, false);
  // `to` alone is an open start, like endDate alone.
  assert.strictEqual(reportWindow(req({ to: '2026-08-31' })).openStart, true);
});

test('no range at all: the last `defaultDays` clinic days, or everything when defaultDays is null', () => {
  const thirty = reportWindow(req({}));
  assert.strictEqual(thirty.days, 30);
  assert.strictEqual(thirty.startKey, addClinicDays(today, -29));
  assert.strictEqual(thirty.endKey, today);
  const seven = reportWindow(req({}), { defaultDays: 7 });
  assert.strictEqual(seven.days, 7);
  const all = reportWindow(req({}), { defaultDays: null });
  assert.strictEqual(all.openStart, true);
  assert.strictEqual(all.endKey, today);
});

test('ISO instants are read as their clinic day; junk is ignored', () => {
  // 20:00 UTC on the 1st is 01:30 IST on the 2nd.
  const w = reportWindow(req({ startDate: '2026-09-01T20:00:00.000Z', endDate: '2026-09-05T20:00:00.000Z' }));
  assert.strictEqual(w.startKey, '2026-09-02');
  assert.strictEqual(w.endKey, '2026-09-06');
  const junk = reportWindow(req({ startDate: 'not-a-date', endDate: 'nope' }));
  assert.strictEqual(junk.endKey, today);
  assert.strictEqual(junk.days, 30);
});

/* ---------------------------------------------------------------------- *
 * Response cache
 * ---------------------------------------------------------------------- */

const fakeRes = () => {
  const r = { statusCode: 200, headers: {}, body: undefined, sent: 0 };
  r.set = (k, v) => { r.headers[k] = v; return r; };
  r.get = (k) => r.headers[k];
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; r.sent += 1; return r; };
  return r;
};
/** Run the middleware; when it calls next(), answer with `handler`. */
const run = async (mw, request, handler) => {
  const res = fakeRes();
  let nexted = false;
  await mw(request, res, () => { nexted = true; handler(res); });
  return { res, nexted };
};
const admin = (extra = {}) => ({ role: 'staff', roleKey: 'manager', ...extra });

test('cache: MISS then HIT for the same URL and scope; the handler runs once', async () => {
  responseCache.clear();
  let clock = 1_000_000;
  const mw = responseCache.cacheFor(60, { now: () => clock });
  let runs = 0;
  const handler = (res) => { runs += 1; res.status(200).json({ success: true, data: { n: runs } }); };
  const r1 = await run(mw, req({}, admin()), handler);
  assert.strictEqual(r1.nexted, true);
  assert.strictEqual(r1.res.headers['X-Cache'], 'MISS');
  assert.strictEqual(r1.res.headers['Cache-Control'], 'private, max-age=60');
  assert.deepStrictEqual(r1.res.body, { success: true, data: { n: 1 } });

  clock += 10_000;
  const r2 = await run(mw, req({}, admin()), handler);
  assert.strictEqual(r2.nexted, false);
  assert.strictEqual(r2.res.headers['X-Cache'], 'HIT');
  assert.strictEqual(r2.res.headers['Cache-Control'], 'private, max-age=50');
  assert.deepStrictEqual(r2.res.body, { success: true, data: { n: 1 } });
  assert.strictEqual(runs, 1);
});

test('cache: the key includes the caller scope, never just the URL', async () => {
  responseCache.clear();
  const mw = responseCache.cacheFor(60);
  let runs = 0;
  const handler = (res) => { runs += 1; res.status(200).json({ runs }); };
  await run(mw, req({}, admin({ branchId: 'b1' })), handler);
  const other = await run(mw, req({}, admin({ branchId: 'b2' })), handler);
  assert.strictEqual(other.res.headers['X-Cache'], 'MISS', 'another centre must not read b1\'s answer');
  const doctor = await run(mw, req({}, { role: 'doctor', roleKey: 'doctor' }), handler);
  assert.strictEqual(doctor.res.headers['X-Cache'], 'MISS', 'a dermatologist never reads a desk answer');
  const same = await run(mw, req({}, admin({ branchId: 'b1' })), handler);
  assert.strictEqual(same.res.headers['X-Cache'], 'HIT');
  assert.strictEqual(runs, 3);
  // Scope is role + centres — not the admin id: two managers of one centre share.
  assert.strictEqual(responseCache.scopeKeyOf({ admin: admin({ _id: 'a', branchId: 'b1' }) }), responseCache.scopeKeyOf({ admin: admin({ _id: 'b', branchId: 'b1' }) }));
  assert.notStrictEqual(responseCache.scopeKeyOf({ admin: admin({ branchIds: ['b1', 'b2'] }) }), responseCache.scopeKeyOf({ admin: admin({ branchIds: ['b1'] }) }));
  assert.notStrictEqual(responseCache.scopeKeyOf({ admin: admin({ assignments: [{ branchId: 'b9' }] }) }), responseCache.scopeKeyOf({ admin: admin() }));
});

test('cache: a different query string is a different entry', async () => {
  responseCache.clear();
  const mw = responseCache.cacheFor(60);
  const handler = (res) => res.status(200).json({ ok: true });
  await run(mw, { ...req({}, admin()), originalUrl: '/api/admin/analytics/x?startDate=2026-09-01' }, handler);
  const r = await run(mw, { ...req({}, admin()), originalUrl: '/api/admin/analytics/x?startDate=2026-09-02' }, handler);
  assert.strictEqual(r.res.headers['X-Cache'], 'MISS');
});

test('cache: an entry expires after the TTL', async () => {
  responseCache.clear();
  let clock = 5_000_000;
  const mw = responseCache.cacheFor(60, { now: () => clock });
  let runs = 0;
  const handler = (res) => { runs += 1; res.status(200).json({ runs }); };
  await run(mw, req({}, admin()), handler);
  clock += 59_999;
  assert.strictEqual((await run(mw, req({}, admin()), handler)).res.headers['X-Cache'], 'HIT');
  clock += 2;
  const late = await run(mw, req({}, admin()), handler);
  assert.strictEqual(late.res.headers['X-Cache'], 'MISS');
  assert.strictEqual(runs, 2);
});

test('cache: non-200 answers are never stored', async () => {
  responseCache.clear();
  const mw = responseCache.cacheFor(60);
  let runs = 0;
  const failing = (res) => { runs += 1; res.status(500).json({ success: false }); };
  await run(mw, req({}, admin()), failing);
  const again = await run(mw, req({}, admin()), failing);
  assert.strictEqual(again.nexted, true);
  assert.strictEqual(again.res.headers['X-Cache'], 'MISS');
  assert.strictEqual(again.res.headers['Cache-Control'], undefined);
  assert.strictEqual(runs, 2);
});

test('cache: POST (and every non-GET) passes straight through, untouched', async () => {
  responseCache.clear();
  const mw = responseCache.cacheFor(60);
  let runs = 0;
  const handler = (res) => { runs += 1; res.status(200).json({ runs }); };
  const post = { ...req({}, admin()), method: 'POST' };
  await run(mw, post, handler);
  const again = await run(mw, post, handler);
  assert.strictEqual(again.nexted, true);
  assert.strictEqual(again.res.headers['X-Cache'], undefined);
  assert.strictEqual(runs, 2);
  assert.strictEqual(responseCache.stats().entries, 0);
});

test('cache: clear() empties it and reports how many went', async () => {
  responseCache.clear();
  const mw = responseCache.cacheFor(60);
  const handler = (res) => res.status(200).json({ ok: true });
  await run(mw, { ...req({}, admin()), originalUrl: '/a' }, handler);
  await run(mw, { ...req({}, admin()), originalUrl: '/b' }, handler);
  assert.strictEqual(responseCache.stats().entries, 2);
  assert.strictEqual(responseCache.clear(), 2);
  assert.strictEqual(responseCache.stats().entries, 0);
  assert.strictEqual((await run(mw, { ...req({}, admin()), originalUrl: '/a' }, handler)).res.headers['X-Cache'], 'MISS');
});

test('cache: bounded — the least recently used entry goes first', async () => {
  responseCache.clear();
  responseCache.setMaxEntries(2);
  try {
    const mw = responseCache.cacheFor(60);
    const handler = (res) => res.status(200).json({ ok: true });
    const at = (url) => ({ ...req({}, admin()), originalUrl: url });
    await run(mw, at('/a'), handler);
    await run(mw, at('/b'), handler);
    await run(mw, at('/a'), handler); // touch a, so b is now the oldest
    await run(mw, at('/c'), handler); // evicts b
    assert.strictEqual(responseCache.stats().entries, 2);
    assert.strictEqual((await run(mw, at('/a'), handler)).res.headers['X-Cache'], 'HIT');
    assert.strictEqual((await run(mw, at('/b'), handler)).res.headers['X-Cache'], 'MISS');
  } finally {
    responseCache.setMaxEntries(responseCache.DEFAULT_MAX_ENTRIES);
    responseCache.clear();
  }
});

test('cache: concurrent identical requests share one handler run (WAIT), the leader stores it', async () => {
  responseCache.clear();
  const mw = responseCache.cacheFor(60);
  let runs = 0;
  let finish;
  const slow = new Promise((resolve) => { finish = resolve; });
  // The leader's handler does not answer until we say so.
  const leader = fakeRes();
  let leaderNexted = false;
  await mw(req({}, admin()), leader, () => { leaderNexted = true; runs += 1; slow.then(() => leader.status(200).json({ runs })); });
  assert.strictEqual(leaderNexted, true);
  assert.strictEqual(responseCache.stats().inflight, 1);

  const follower = fakeRes();
  let followerNexted = false;
  const waiting = mw(req({}, admin()), follower, () => { followerNexted = true; runs += 1; });
  finish();
  await waiting;
  assert.strictEqual(followerNexted, false, 'the follower must not run the handler again');
  assert.strictEqual(follower.res ? follower.res.headers['X-Cache'] : follower.headers['X-Cache'], 'WAIT');
  assert.deepStrictEqual(follower.body, { runs: 1 });
  assert.strictEqual(runs, 1);
  assert.strictEqual(responseCache.stats().inflight, 0);
  const later = await run(mw, req({}, admin()), () => { runs += 1; });
  assert.strictEqual(later.res.headers['X-Cache'], 'HIT');
});

test('cache: when the leader fails, followers compute their own answer', async () => {
  responseCache.clear();
  const mw = responseCache.cacheFor(60);
  const leader = fakeRes();
  let fail;
  const failing = new Promise((resolve) => { fail = resolve; });
  await mw(req({}, admin()), leader, () => { failing.then(() => leader.status(500).json({ success: false })); });
  const follower = fakeRes();
  let followerRan = false;
  const waiting = mw(req({}, admin()), follower, () => { followerRan = true; follower.status(200).json({ ok: true }); });
  fail();
  await waiting;
  assert.strictEqual(followerRan, true);
  assert.deepStrictEqual(follower.body, { ok: true });
  assert.strictEqual(responseCache.stats().inflight, 0);
});
