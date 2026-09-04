/**
 * Name normalisation for matching our records to Zenoti's.
 *
 * Exact-string matching missed most of the curated catalogue: "Laser Hair
 * Removal (LHR)" vs "Laser Hair Removal", "Q-Switch Laser" vs "Q Switch
 * Laser", "Doublo HIFU" vs "DOUBLO - HIFU". This collapses case, punctuation,
 * bracketed suffixes, "&"/"and", and common noise words, so those meet —
 * while still refusing anything that is not the same words.
 */
const NOISE = new Set(['the', 'a', 'an', 'of', 'for', 'with', 'treatment', 'treatments', 'session', 'sessions']);

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')          // "(LHR)", "(Morpheus)"
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !NOISE.has(w))
    .join(' ')
    .trim();
}

/** Token-set key: same words in any order → same key. */
function tokenKey(value) {
  return normalizeName(value).split(' ').filter(Boolean).sort().join(' ');
}

/**
 * Find the single row whose name matches `name` after normalisation.
 * Returns null when there is no match OR more than one (ambiguity is a person's call).
 */
function findByName(rows, name, get = (r) => r.name) {
  const want = normalizeName(name);
  if (!want) return null;
  let hits = rows.filter((r) => normalizeName(get(r)) === want);
  if (!hits.length) {
    const key = tokenKey(name);
    hits = rows.filter((r) => tokenKey(get(r)) === key);
  }
  return hits.length === 1 ? hits[0] : null;
}

module.exports = { normalizeName, tokenKey, findByName };
