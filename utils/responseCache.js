/**
 * A tiny in-process TTL cache for GET handlers whose answer is expensive and
 * moves slowly — the analytics page.
 *
 * Why it exists: the Analytics page fires fourteen requests on every load and
 * every range change, and each of them shaped the window's rows in memory.
 * Two people opening the page inside a minute doubled that load on a small
 * EC2 for numbers that had not changed. Sixty seconds of memory makes the
 * second open — and every range flip back — instant, without any of the
 * write paths having to know the cache exists.
 *
 * What is keyed: the full request URL (path + query, so the window and the
 * `branchId` filter are part of the key) plus the caller's SCOPE — role and
 * the centres the account is pinned to — never the admin id. Two admins with
 * the same scope share an answer; a centre-pinned or dermatologist login never
 * receives another scope's cached body, because its key differs.
 *
 * Only a 200 JSON body is stored. Errors, redirects and every non-GET pass
 * straight through. The store is bounded (least recently used out first), so
 * a burst of distinct custom windows cannot grow it without limit.
 */

const DEFAULT_MAX_ENTRIES = 200;

const store = new Map(); // key -> { expiresAt, body }
let maxEntries = DEFAULT_MAX_ENTRIES;

/**
 * The part of the key that says WHO is asking, in scope terms: role, effective
 * role key, and the centres an account is limited to (a home `branchId`, a
 * `branchIds` list, or per-centre `assignments`). protectAdmin sets these on
 * `req.admin`; a request without one (should never reach an analytics route)
 * caches under 'anon' so it can never collide with a staff answer.
 */
function scopeKeyOf(req) {
  const a = req.admin;
  if (!a) return 'anon';
  const ids = new Set();
  if (a.branchId) ids.add(String(a.branchId));
  for (const b of Array.isArray(a.branchIds) ? a.branchIds : []) if (b) ids.add(String(b));
  for (const x of Array.isArray(a.assignments) ? a.assignments : []) if (x && x.branchId) ids.add(String(x.branchId));
  const branches = [...ids].sort().join(',');
  return [a.role || '', a.roleKey || '', a.isSuperAdmin ? 'super' : '', branches].join('|');
}

const keyOf = (req) => `${scopeKeyOf(req)}#${req.originalUrl || req.url || ''}`;

function put(key, entry) {
  // Re-insert so the Map's iteration order doubles as "least recently used".
  store.delete(key);
  store.set(key, entry);
  while (store.size > maxEntries) {
    const oldest = store.keys().next().value;
    store.delete(oldest);
  }
}

/**
 * Express middleware: serve a fresh cached 200 for this URL + scope, else let
 * the handler run and remember what it answers.
 *
 * `now` is injectable so the expiry rule can be tested without sleeping.
 */
function cacheFor(seconds, { now = Date.now } = {}) {
  const ttlMs = Math.max(0, Number(seconds) || 0) * 1000;
  return function responseCache(req, res, next) {
    if (req.method !== 'GET' || ttlMs === 0) return next();
    const key = keyOf(req);
    const at = now();
    const hit = store.get(key);
    if (hit && hit.expiresAt > at) {
      put(key, hit); // touch, so a hot window is not the first evicted
      res.set('Cache-Control', `private, max-age=${Math.ceil((hit.expiresAt - at) / 1000)}`);
      res.set('X-Cache', 'HIT');
      return res.status(200).json(hit.body);
    }
    if (hit) store.delete(key);

    const original = res.json.bind(res);
    res.set('X-Cache', 'MISS');
    res.json = function cachingJson(body) {
      // res.status(...) runs before .json(...), so the code is settled here.
      if (res.statusCode === 200 && body && typeof body === 'object') {
        res.set('Cache-Control', `private, max-age=${seconds}`);
        put(key, { expiresAt: now() + ttlMs, body });
      }
      return original(body);
    };
    return next();
  };
}

/** Drop everything — the numbers changed, or an operator asked. Returns how many entries went. */
function clear() {
  const n = store.size;
  store.clear();
  return n;
}

function stats() {
  return { entries: store.size, maxEntries };
}

/** Test hook: shrink the bound to prove eviction without 200 requests. */
function setMaxEntries(n) {
  maxEntries = Math.max(1, Number(n) || DEFAULT_MAX_ENTRIES);
  while (store.size > maxEntries) store.delete(store.keys().next().value);
}

module.exports = { cacheFor, clear, stats, scopeKeyOf, keyOf, setMaxEntries, DEFAULT_MAX_ENTRIES };
