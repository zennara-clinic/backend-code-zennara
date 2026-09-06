/**
 * Catalogue taxonomy (category / sub-category / formulation) hygiene.
 *
 * The sheet is the source of truth for NAMES, but spelling drifts: "Skin Care"
 * beside "Skincare", "Anti- Aging" beside "Anti-Aging", "None." meaning blank.
 * Two names are the SAME bucket when they match after lower-casing and
 * dropping everything that is not a letter or digit. The spelling that is used
 * most often in the catalogue wins; new products and imports are snapped to it.
 */
const BLANK = new Set(['', 'none', 'none.', 'na', 'n/a', 'nil', '-', '—', 'null', 'undefined', 'general']);

/** Key that two spellings of the same bucket share. */
function taxonomyKey(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Tidy one name: collapse whitespace, fix "Anti- Aging" → "Anti-Aging", blank → null. */
function tidyName(name) {
  if (name === null || name === undefined) return null;
  let s = String(name).replace(/\s+/g, ' ').replace(/\s*-\s*/g, '-').replace(/\s*&\s*/g, ' & ').replace(/\s*\/\s*/g, ' / ').trim();
  if (BLANK.has(s.toLowerCase())) return null;
  return s;
}

/**
 * Build the canonical spelling per key from the rows that exist today.
 * rows: [{ name, count }] — the most frequent spelling wins, ties go to the
 * shorter/plainer one.
 */
function buildCanon(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const name = tidyName(r.name); if (!name) continue;
    const key = taxonomyKey(name); if (!key) continue;
    const bucket = byKey.get(key) || new Map();
    bucket.set(name, (bucket.get(name) || 0) + (Number(r.count) || 1));
    byKey.set(key, bucket);
  }
  const canon = new Map();
  for (const [key, bucket] of byKey) {
    const best = [...bucket.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]))[0][0];
    canon.set(key, best);
  }
  return canon;
}

/** Snap a name to the catalogue's canonical spelling (or tidy it when new). */
function canonicalName(name, canon) {
  const tidy = tidyName(name); if (!tidy) return null;
  const hit = canon && canon.get(taxonomyKey(tidy));
  return hit || tidy;
}

/** Canon maps for the three fields, read from the products collection. */
async function loadCanon(Product, filter = {}) {
  const out = {};
  for (const field of ['productCategory', 'productSubCategory', 'formulation']) {
    const rows = await Product.aggregate([{ $match: filter }, { $group: { _id: `$${field}`, n: { $sum: 1 } } }]);
    out[field] = buildCanon(rows.map((r) => ({ name: r._id, count: r.n })));
  }
  return out;
}

/** Apply canonical spellings to a plain product-like object (mutates + returns changed field names). */
function snapProduct(doc, canon) {
  const changed = [];
  for (const field of ['productCategory', 'productSubCategory', 'formulation']) {
    if (doc[field] === undefined) continue;
    const next = canonicalName(doc[field], canon[field]);
    if ((next || null) !== (doc[field] || null)) { doc[field] = next; changed.push(field); }
  }
  // The app groups by formulation; keep it equal to the sub-category when it is blank.
  if (!doc.formulation && doc.productSubCategory) { doc.formulation = doc.productSubCategory; changed.push('formulation'); }
  return changed;
}

module.exports = { taxonomyKey, tidyName, buildCanon, canonicalName, loadCanon, snapProduct };
