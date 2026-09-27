/**
 * The shop's taxonomy: how the product catalogue is divided for guests.
 *
 * Three independent ways into the same products —
 *
 *   • COLLECTIONS  the rail across the top of the shop: All products,
 *                  Bestsellers, New arrivals, Kids. Hand-picked in the panel
 *                  (`Product.shopCollections`); "All products" is not stored.
 *   • CATEGORIES   what the product IS (Cleansers, Serums & Essences…).
 *                  `Product.productCategory` is the main one and
 *                  `Product.categories` lists every one it belongs to — a hair
 *                  supplement sits under both Hair Care and Supplements.
 *   • CONCERNS     what the guest wants help WITH (Acne, Pigmentation,
 *                  Hairfall…), grouped by area of the body. Stored on the
 *                  product as slugs (`Product.concerns`).
 *
 * Names live here, once. The app, the panels and the importer all read this
 * file (through GET /api/products/taxonomy), so a rename is one edit. `icon`
 * is a key the app maps to a drawing — never a URL — so the shop renders
 * before any photography exists.
 *
 * A concern can sit under two areas (Acne is a Face and a Body concern). It is
 * ONE concern with one product list; the areas are only how the menu is laid
 * out.
 */

const slugify = (v) => String(v || '').toLowerCase().trim().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const COLLECTIONS = [
  { slug: 'bestseller', name: 'Bestsellers', blurb: 'What guests come back for', icon: 'award' },
  { slug: 'new-arrival', name: 'New arrivals', blurb: 'Recently added to the shelf', icon: 'sparkles' },
  { slug: 'kids', name: 'Kids', blurb: 'Gentle care for young skin', icon: 'baby' },
];

const CATEGORIES = [
  { name: 'Cleansers', icon: 'cleanser', blurb: 'Face washes and cleansing gels' },
  { name: 'Toners', icon: 'toner', blurb: 'Balancing and prepping' },
  { name: 'Serums & Essences', icon: 'serum', blurb: 'Concentrated actives' },
  { name: 'Moisturisers', icon: 'moisturiser', blurb: 'Creams, gels and emulsions' },
  { name: 'Sunscreens', icon: 'sunscreen', blurb: 'Daily sun protection' },
  { name: 'Eye Care', icon: 'eye', blurb: 'For the delicate eye area' },
  { name: 'Lip Care', icon: 'lip', blurb: 'Balms and lip treatments' },
  { name: 'Face Masks', icon: 'mask', blurb: 'Weekly resets' },
  { name: 'Exfoliants & Scrubs', icon: 'exfoliant', blurb: 'Smoother, clearer texture' },
  { name: 'Body Care', icon: 'body', blurb: 'Washes, lotions and body treatments' },
  { name: 'Hair Care', icon: 'hair', blurb: 'Shampoos, serums and scalp care' },
  { name: 'Supplements', icon: 'supplement', blurb: 'Skin, hair and wellness nutrition' },
  { name: 'Kits & Sets', icon: 'kit', blurb: 'Routines, boxed together' },
];

const CONCERNS = [
  // Face
  { slug: 'acne', name: 'Acne', icon: 'acne', blurb: 'Clarifying cleansers, serums and spot care' },
  { slug: 'acne-scars', name: 'Acne Scars', icon: 'scar', blurb: 'Resurfacing and repair for uneven texture' },
  { slug: 'acne-marks-blemishes', name: 'Acne Marks & Blemishes', icon: 'blemish', blurb: 'Fading the marks breakouts leave behind' },
  { slug: 'blackheads-whiteheads', name: 'Blackheads & Whiteheads', icon: 'pore', blurb: 'Decongesting care for clogged pores' },
  { slug: 'dry-skin', name: 'Dry Skin', icon: 'droplet', blurb: 'Barrier support and lasting hydration' },
  { slug: 'dull-skin', name: 'Dull Skin', icon: 'glow', blurb: 'Brightening care for a fresher tone' },
  { slug: 'fine-lines', name: 'Fine Lines', icon: 'lines', blurb: 'Smoothing actives for early lines' },
  { slug: 'open-pores', name: 'Open Pores', icon: 'pore', blurb: 'Refining care for visible pores' },
  { slug: 'pigmentation', name: 'Pigmentation', icon: 'pigment', blurb: 'Targeted care for dark patches and spots' },
  { slug: 'rosacea-redness', name: 'Rosacea & Redness', icon: 'calm', blurb: 'Calming care for reactive skin' },
  { slug: 'sun-tan-sun-damage', name: 'Sun Tan & Sun Damage', icon: 'sun', blurb: 'Protection and recovery after sun' },
  { slug: 'uneven-skin-tone', name: 'Uneven Skin Tone', icon: 'tone', blurb: 'Evening out patchy, blotchy tone' },
  { slug: 'wrinkles', name: 'Wrinkles', icon: 'lines', blurb: 'Firming care for deeper lines' },
  // Eye
  { slug: 'dark-circles', name: 'Dark Circles', icon: 'eye', blurb: 'Brightening care for the under-eye' },
  { slug: 'eye-bags', name: 'Eye Bags', icon: 'eye', blurb: 'Firming care beneath the eye' },
  { slug: 'puffy-eyes', name: 'Puffy Eyes', icon: 'eye', blurb: 'Cooling, de-puffing eye care' },
  // Lips
  { slug: 'dry-lips', name: 'Dry Lips', icon: 'lip', blurb: 'Balms that repair and protect' },
  { slug: 'lip-pigmentation', name: 'Lip Pigmentation', icon: 'lip', blurb: 'Care for darkened lips' },
  // Body
  { slug: 'body-fat', name: 'Body Fat', icon: 'body', blurb: 'Contouring and firming care' },
  { slug: 'stretch-marks', name: 'Stretch Marks', icon: 'body', blurb: 'Care for stretched, marked skin' },
  { slug: 'psoriasis', name: 'Psoriasis', icon: 'calm', blurb: 'Soothing care for scaling skin and scalp' },
  // Hair
  { slug: 'dandruff', name: 'Dandruff', icon: 'scalp', blurb: 'Scalp care for flaking and itch' },
  { slug: 'dry-hair', name: 'Dry Hair', icon: 'droplet', blurb: 'Moisture for brittle lengths' },
  { slug: 'dull-hair', name: 'Dull Hair', icon: 'glow', blurb: 'Bringing back softness and shine' },
  { slug: 'heat-damaged-hair', name: 'Heat Damaged Hair', icon: 'hair', blurb: 'Repair after styling and colour' },
  { slug: 'hair-thinning', name: 'Hair Thinning', icon: 'hair', blurb: 'Support for density and strength' },
  { slug: 'oily-scalp', name: 'Oily Scalp', icon: 'scalp', blurb: 'Balancing care for a greasy scalp' },
  { slug: 'frizzy-hair', name: 'Frizzy Hair', icon: 'hair', blurb: 'Smoothing care for unruly hair' },
  { slug: 'hairfall', name: 'Hairfall', icon: 'hair', blurb: 'Strengthening care from the root' },
  { slug: 'split-ends', name: 'Split Ends', icon: 'hair', blurb: 'Sealing and protecting the ends' },
  { slug: 'dermatitis-eczema', name: 'Dermatitis & Eczema', icon: 'calm', blurb: 'Gentle care for an irritated scalp' },
];

const CONCERN_AREAS = [
  { slug: 'face', name: 'Face', concerns: ['acne', 'acne-scars', 'acne-marks-blemishes', 'blackheads-whiteheads', 'dry-skin', 'dull-skin', 'fine-lines', 'open-pores', 'pigmentation', 'rosacea-redness', 'sun-tan-sun-damage', 'uneven-skin-tone', 'wrinkles'] },
  { slug: 'eye', name: 'Eye', concerns: ['dark-circles', 'eye-bags', 'fine-lines', 'puffy-eyes'] },
  { slug: 'lips', name: 'Lips', concerns: ['dry-lips', 'lip-pigmentation'] },
  { slug: 'body', name: 'Body', concerns: ['acne', 'body-fat', 'dry-skin', 'pigmentation', 'stretch-marks', 'uneven-skin-tone', 'psoriasis'] },
  { slug: 'hair', name: 'Hair', concerns: ['dandruff', 'dry-hair', 'dull-hair', 'heat-damaged-hair', 'hair-thinning', 'oily-scalp', 'frizzy-hair', 'hairfall', 'psoriasis', 'split-ends', 'dermatitis-eczema'] },
];

const COLLECTION_BY_SLUG = new Map(COLLECTIONS.map((c) => [c.slug, c]));
const CONCERN_BY_SLUG = new Map(CONCERNS.map((c) => [c.slug, c]));
const CONCERN_BY_KEY = new Map(CONCERNS.flatMap((c) => [[slugify(c.name), c], [c.slug, c]]));
const CATEGORY_BY_KEY = new Map(CATEGORIES.map((c) => [slugify(c.name), c]));

const list = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map((x) => String(x ?? '').trim()).filter(Boolean);
const unique = (rows) => [...new Set(rows)];

/** Concern slugs from whatever the panel or an import sent (slugs or names); unknown ones are dropped. */
function normaliseConcerns(value) {
  return unique(list(value).map((v) => CONCERN_BY_KEY.get(slugify(v))?.slug).filter(Boolean));
}

/** Collection slugs, known ones only. */
function normaliseCollections(value) {
  return unique(list(value).map((v) => slugify(v)).map((s) => (s === 'bestsellers' ? 'bestseller' : s === 'new-arrivals' ? 'new-arrival' : s)).filter((s) => COLLECTION_BY_SLUG.has(s)));
}

/**
 * Category names. A known category snaps to its spelling here; a new one the
 * panel typed is kept as written, so the clinic can open a category without a
 * deploy (it shows in the app with the default drawing).
 */
function normaliseCategories(value) {
  return unique(list(value).map((v) => CATEGORY_BY_KEY.get(slugify(v))?.name || v.replace(/\s+/g, ' ').trim()).filter(Boolean));
}

/**
 * Keep the three category-ish fields telling one story before a save:
 * the main category is always in `categories`, `categories` is never empty
 * while a main category exists, and Bestsellers mirrors the older `isPopular`
 * switch the home rail and older app builds still read.
 *
 * `touched` names what the caller changed, so the field that was edited wins.
 */
function reconcile(product, touched = {}) {
  const main = product.productCategory ? normaliseCategories([product.productCategory])[0] : null;
  let all = normaliseCategories(product.categories || []);
  if (touched.categories && !touched.productCategory) {
    // The list was edited: the main category must be one of them.
    if (!main || !all.includes(main)) product.productCategory = all[0] || null;
  } else if (main) {
    product.productCategory = main;
    if (!all.includes(main)) all = [main, ...all];
  }
  product.categories = all;

  let collections = normaliseCollections(product.shopCollections || []);
  if (touched.isPopular && !touched.shopCollections) {
    collections = product.isPopular ? unique(['bestseller', ...collections]) : collections.filter((s) => s !== 'bestseller');
  }
  product.shopCollections = collections;
  product.isPopular = collections.includes('bestseller');
  product.concerns = normaliseConcerns(product.concerns || []);
  return product;
}

/**
 * The taxonomy with live counts, for the shop's landing page.
 * `counts` = { collections: Map, categories: Map, concerns: Map, total }.
 * Anything with no product is left out unless `includeEmpty` (the panel wants
 * the full menu to choose from; a guest must never open an empty shelf).
 */
function present(counts, { includeEmpty = false } = {}) {
  const n = (map, key) => Number(map?.get(key)) || 0;
  const keep = (row) => includeEmpty || row.count > 0;
  const known = new Set(CATEGORIES.map((c) => c.name));
  const extraCategories = [...(counts.categories?.keys() || [])]
    .filter((name) => name && !known.has(name))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, icon: 'product', blurb: '' }));
  const concerns = CONCERNS.map((c) => ({ ...c, count: n(counts.concerns, c.slug) }));
  const concernBySlug = new Map(concerns.map((c) => [c.slug, c]));
  return {
    total: Number(counts.total) || 0,
    collections: COLLECTIONS.map((c) => ({ ...c, count: n(counts.collections, c.slug) })).filter(keep),
    categories: [...CATEGORIES, ...extraCategories].map((c) => ({ ...c, slug: slugify(c.name), count: n(counts.categories, c.name) })).filter(keep),
    concerns: concerns.filter(keep),
    concernAreas: CONCERN_AREAS
      .map((a) => ({ slug: a.slug, name: a.name, concerns: a.concerns.map((s) => concernBySlug.get(s)).filter(Boolean).filter(keep) }))
      .filter((a) => includeEmpty || a.concerns.length > 0),
  };
}

/** Live counts for `present`, over the products matching `match`. */
async function countTaxonomy(Product, match = {}) {
  const [facet] = await Product.aggregate([
    { $match: match },
    {
      $facet: {
        total: [{ $count: 'n' }],
        collections: [{ $unwind: '$shopCollections' }, { $group: { _id: '$shopCollections', n: { $sum: 1 } } }],
        concerns: [{ $unwind: '$concerns' }, { $group: { _id: '$concerns', n: { $sum: 1 } } }],
        // A product with no `categories` yet (created before they existed) still counts under its main category.
        categories: [
          { $project: { c: { $cond: [{ $gt: [{ $size: { $ifNull: ['$categories', []] } }, 0] }, '$categories', [{ $ifNull: ['$productCategory', null] }]] } } },
          { $unwind: '$c' },
          { $match: { c: { $ne: null } } },
          { $group: { _id: '$c', n: { $sum: 1 } } },
        ],
      },
    },
  ]);
  const toMap = (rows) => new Map((rows || []).map((r) => [r._id, r.n]));
  return {
    total: facet?.total?.[0]?.n || 0,
    collections: toMap(facet?.collections),
    concerns: toMap(facet?.concerns),
    categories: toMap(facet?.categories),
  };
}

/** Mongo clause: the product belongs to this category (main or additional). */
function categoryFilter(name) {
  const canon = normaliseCategories([name])[0];
  if (!canon) return {};
  return { $or: [{ categories: canon }, { productCategory: canon }] };
}

module.exports = {
  COLLECTIONS,
  CATEGORIES,
  CONCERNS,
  CONCERN_AREAS,
  COLLECTION_BY_SLUG,
  CONCERN_BY_SLUG,
  slugify,
  normaliseConcerns,
  normaliseCollections,
  normaliseCategories,
  reconcile,
  present,
  countTaxonomy,
  categoryFilter,
};
