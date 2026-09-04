/**
 * Match a name that came from Zenoti to one of our catalogue rows.
 *
 * Sale lines are historical — "Sebium Gel Moussant 899", "Azelac r u serum -
 * 2650", "Cetaphil Optimal Hydration Daily cream 50 GM 1299" — they carry the
 * price of the day, spacing quirks and old spellings. Exact matching finds
 * almost nothing, so this goes through progressively looser passes and only
 * ever accepts a UNIQUE hit; an ambiguous name is left for a person (null).
 *
 * Sizes and strengths are NEVER ignored: "90ml" and "240ml" are different
 * products, "0.5" and "1.0" different creams. Only a bare trailing price
 * (a number of three or more digits with no unit) is dropped.
 *
 * `strict` (catalogue-to-catalogue reconciliation) disables the last,
 * containment pass — "Laser Toning" must not swallow "Laser Toning & Photo
 * Treatments" — and is for names that should be the same thing spelt
 * differently, not a sale line naming a product.
 */
const { normalizeName, tokenKey } = require('./nameMatch');

const UNITS = new Set(['ml', 'gm', 'g', 'gms', 'mg', 'kg', 'l', 'ltr', 'pcs', 'pc', 'tab', 'tabs', 'cap', 'caps', 'nos']);

/** Words that describe the thing: sizes kept as one token, prices dropped. */
function coreTokens(v) {
  const raw = normalizeName(v).split(' ').filter(Boolean);
  const out = [];
  for (let i = 0; i < raw.length; i += 1) {
    const w = raw[i];
    const next = raw[i + 1];
    if (/^\d+$/.test(w) && next && UNITS.has(next)) { out.push(`${w}${next === 'g' || next === 'gms' ? 'gm' : next}`); i += 1; continue; }
    const m = w.match(/^(\d+)(ml|gm|g|gms|mg|kg|l)$/);
    if (m) { out.push(`${m[1]}${m[2] === 'g' || m[2] === 'gms' ? 'gm' : m[2]}`); continue; }
    if (/^\d{3,}$/.test(w)) continue;            // a price
    if (UNITS.has(w)) continue;                  // a stray unit
    out.push(w);
  }
  return out;
}
const squash = (v) => normalizeName(v).replace(/\s+/g, '');
const coreKey = (v) => coreTokens(v).sort().join(' ');
const coreSquash = (v) => coreTokens(v).join('');

/**
 * Build a matcher over `rows` once, then call it many times (cheap).
 * `get` picks the row's name. Returns the row or null.
 */
function buildMatcher(rows, get = (r) => r.name, { strict = false } = {}) {
  const fns = [normalizeName, tokenKey, squash, coreKey, coreSquash];
  const passes = fns.map((fn) => {
    const map = new Map();
    for (const r of rows) {
      const k = fn(get(r));
      if (!k) continue;
      map.set(k, map.has(k) ? null : r); // null = ambiguous
    }
    return map;
  });
  const index = rows.map((r) => ({ r, tokens: coreTokens(get(r)) }));

  return function match(name) {
    if (!name) return null;
    for (let i = 0; i < passes.length; i += 1) {
      const k = fns[i](name);
      if (k && passes[i].has(k)) return passes[i].get(k); // ambiguous → null, final
    }
    if (strict) return null;
    // Last resort for sale lines: every word of exactly one catalogue row
    // appears in the sale name (the sale adds price, dashes, a note) — and the
    // row has at least two words so "serum" alone can never match.
    const want = new Set(coreTokens(name));
    const hits = index.filter(({ tokens }) => tokens.length >= 2 && tokens.every((w) => want.has(w)));
    return hits.length === 1 ? hits[0].r : null;
  };
}

module.exports = { buildMatcher, coreTokens };
