/**
 * The treatment menu — the one source of names for the app's two treatment tabs.
 *
 *   By treatments  → CATEGORIES, nine flat groups, each drawn with an icon (no sub-level).
 *   By condition   → CONDITIONS, thirteen concerns; a treatment lists the ones it helps with
 *                    in `Consultation.conditions` (keys below).
 *
 * Categories also live as `Category` documents (name, displayOrder, icon) so the panel can
 * rename, reorder or re-icon them; this list is what scripts/replaceTreatmentCatalogue.js
 * seeds them from and what the app bundles (constants/treatmentTaxonomy.ts) for the moment
 * before GET /consultations/taxonomy answers. Conditions have no document: add one here.
 *
 * Icons are keys, not artwork — the app and the admin panel each draw the same set.
 */

/** Level-1 type every catalogue treatment sits under. The menu is flat, so there is one. */
const TREATMENT_TYPE = 'Treatments';

const CATEGORIES = [
  { key: 'laser-hair-reduction', name: 'Laser Hair Reduction', icon: 'laser-hair-reduction' },
  { key: 'hair-regrowth', name: 'Hair Re-Growth', icon: 'hair-regrowth' },
  { key: 'acne-scar', name: 'Acne / Scar', icon: 'acne-scar' },
  { key: 'skin-rejuvenation', name: 'Skin Rejuvenation', icon: 'skin-rejuvenation' },
  { key: 'insta-glow', name: 'Insta Glow Solutions', icon: 'insta-glow' },
  { key: 'pigmentation', name: 'Pigmentation', icon: 'pigmentation' },
  { key: 'anti-aging', name: 'Anti-Aging', icon: 'anti-aging' },
  { key: 'more', name: 'More', icon: 'more' },
  { key: 'body', name: 'Body', icon: 'body' },
].map((c, i) => ({ ...c, order: i + 1 }));

const CONDITIONS = [
  { key: 'acne-vulgaris', name: 'Acne Vulgaris', blurb: 'Pimples, blackheads and whiteheads from clogged, inflamed pores.' },
  { key: 'acne-scar', name: 'Acne Scar', blurb: 'Marks and dents left behind once acne heals.' },
  { key: 'ageing-issues', name: 'Ageing Issues', blurb: 'Fine lines, wrinkles, sagging and loss of volume or glow.' },
  { key: 'birth-marks', name: 'Birth Marks', blurb: 'Coloured patches present at birth or soon after.' },
  { key: 'dark-circles', name: 'Dark Circles', blurb: 'Darkness or hollowness under the eyes.' },
  { key: 'hypertrichosis', name: 'Hypertrichosis', blurb: 'Excess or unwanted hair on the face or body.' },
  { key: 'hair-loss', name: 'Hair Loss', blurb: 'Hair fall, thinning, a receding hairline or bald patches.' },
  { key: 'moles', name: 'Moles', blurb: 'Brown or skin-coloured spots and bumps on the skin.' },
  { key: 'open-pores', name: 'Open Pores', blurb: 'Enlarged, visible pores, often on the nose and cheeks.' },
  { key: 'skin-pigmentation', name: 'Skin Pigmentation', blurb: 'Dark spots, patches, melasma and uneven skin tone.' },
  { key: 'skin-tags', name: 'Skin Tags', blurb: 'Small, soft growths where the skin creases, like the neck and underarms.' },
  { key: 'stretch-marks', name: 'Stretch Marks', blurb: 'Streaks left by fast stretching of the skin.' },
  { key: 'tanned-skin', name: 'Tanned Skin', blurb: 'Darkening of the skin after time in the sun.' },
].map((c, i) => ({ ...c, order: i + 1 }));

/** Icon keys both clients know how to draw. A category may also carry '' (no icon). */
const ICON_KEYS = CATEGORIES.map((c) => c.icon);

const CONDITION_KEYS = new Set(CONDITIONS.map((c) => c.key));
const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const CONDITION_BY_NAME = new Map(CONDITIONS.map((c) => [slugify(c.name), c.key]));

/** Accepts keys or names ("Acne Scar", "acne-scar"), returns known keys once each, in menu order. */
function normaliseConditions(list) {
  const raw = Array.isArray(list) ? list : String(list || '').split(',');
  const keys = new Set();
  for (const item of raw) {
    const s = slugify(item);
    if (CONDITION_KEYS.has(s)) keys.add(s);
    else if (CONDITION_BY_NAME.has(s)) keys.add(CONDITION_BY_NAME.get(s));
  }
  return CONDITIONS.map((c) => c.key).filter((k) => keys.has(k));
}

/** '' or a known icon key; anything else is refused as ''. */
const normaliseIcon = (v) => (ICON_KEYS.includes(String(v || '').trim()) ? String(v).trim() : '');

/**
 * The live menu for the app: categories that hold at least one visible treatment (in the
 * panel's order, with their icon) and conditions with a count. `treatments` are the
 * app-visible rows ({category, conditions}); `categoryDocs` the Category documents.
 * Empty entries are left out unless `includeEmpty` (the panel's pickers want all of them).
 */
function buildTaxonomy(treatments, categoryDocs, { includeEmpty = false } = {}) {
  const byCategory = new Map();
  const byCondition = new Map();
  for (const t of treatments) {
    if (t.category) byCategory.set(t.category, (byCategory.get(t.category) || 0) + 1);
    for (const k of normaliseConditions(t.conditions)) byCondition.set(k, (byCondition.get(k) || 0) + 1);
  }
  const docs = new Map((categoryDocs || []).map((d) => [d.name, d]));
  const names = new Set([...byCategory.keys(), ...(includeEmpty ? (categoryDocs || []).filter((d) => d.isActive !== false && d.type === TREATMENT_TYPE).map((d) => d.name) : [])]);
  const categories = [...names].map((name) => {
    const doc = docs.get(name);
    return {
      name,
      slug: doc?.slug || slugify(name),
      icon: normaliseIcon(doc?.icon),
      order: Number.isFinite(doc?.displayOrder) ? doc.displayOrder : 999,
      count: byCategory.get(name) || 0,
    };
  }).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  const conditions = CONDITIONS
    .map((c) => ({ ...c, count: byCondition.get(c.key) || 0 }))
    .filter((c) => includeEmpty || c.count > 0);
  return { total: treatments.length, categories, conditions };
}

module.exports = {
  TREATMENT_TYPE,
  CATEGORIES,
  CONDITIONS,
  ICON_KEYS,
  normaliseConditions,
  normaliseIcon,
  buildTaxonomy,
  slugify,
};
