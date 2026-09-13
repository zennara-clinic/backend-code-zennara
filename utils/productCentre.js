/**
 * Centre-wise product listings.
 *
 * The clinic runs three centres and wants the shop to read differently at
 * each: a product may be on sale at Jubilee Hills only, priced differently at
 * Kondapur, or collectable at Financial District but not listed there at all.
 * That is held on the product as `centreListings` — one row per CLINIC centre,
 * written only from the admin panel. It is separate from `centres`, which is
 * Zenoti's per-centre product feed (mostly the pharmacy centres) and says
 * which centre *stocks* the item, not what the app should show.
 *
 * Every rule about how a listing resolves lives here so the shop, the cart
 * pricing and the panel agree:
 *
 *   • No row for a centre = the product's defaults: visible, base price,
 *     collectable. So a product that has never been touched in the panel
 *     behaves exactly as it did before centres existed.
 *   • `visible: false` hides the product from guests shopping at that centre
 *     and refuses it at checkout there.
 *   • `price: null` means "the base price"; a number is the price AT THAT
 *     CENTRE. Both the shop and the bill use the same resolution.
 *   • `pickup: false` keeps the product on sale for delivery but not for
 *     store pickup at that centre (a centre that does not hold it).
 */

const DEFAULT_LISTING = Object.freeze({ visible: true, price: null, pickup: true });

const idOf = (v) => (v && typeof v === 'object' && v._id ? String(v._id) : v ? String(v) : '');

/** The stored row for a centre, or null when the panel has never set one. */
function listingRow(product, branchId) {
  const want = idOf(branchId);
  if (!want) return null;
  const rows = Array.isArray(product?.centreListings) ? product.centreListings : [];
  return rows.find((r) => idOf(r.branchId) === want) || null;
}

/**
 * How the product reads at one centre.
 *
 * @returns {{ visible: boolean, price: number, basePrice: number, centrePrice: number|null, pickup: boolean, listed: boolean }}
 *   `listed` = the panel has an explicit row for this centre.
 */
function resolveListing(product, branchId) {
  const basePrice = Number(product?.price) || 0;
  const row = listingRow(product, branchId);
  if (!row) {
    return { visible: DEFAULT_LISTING.visible, price: basePrice, basePrice, centrePrice: null, pickup: DEFAULT_LISTING.pickup, listed: false };
  }
  const override = row.price === null || row.price === undefined || row.price === '' ? null : Number(row.price);
  const centrePrice = Number.isFinite(override) && override >= 0 ? override : null;
  return {
    visible: row.visible !== false,
    price: centrePrice === null ? basePrice : centrePrice,
    basePrice,
    centrePrice,
    pickup: row.pickup !== false,
    listed: true,
  };
}

/** Is the product on sale for guests shopping at this centre? (No centre = yes.) */
const visibleAt = (product, branchId) => (branchId ? resolveListing(product, branchId).visible : true);

/** What the guest pays for one unit at this centre. */
const priceAt = (product, branchId) => resolveListing(product, branchId).price;

/**
 * Mongo filter: products the guest may see at this centre. Anything without a
 * row for the centre is visible by default, so the filter only has to exclude
 * an explicit `visible: false`.
 */
function visibleAtFilter(branchId) {
  if (!branchId) return {};
  return { centreListings: { $not: { $elemMatch: { branchId, visible: false } } } };
}

/**
 * The product as the app should receive it for one centre: the usual
 * document plus the resolved price. `price` is what the guest pays here;
 * `basePrice` is the list price so the app can show a strike-through when a
 * centre price is lower; `centrePrice` is the override itself (null = none).
 */
function presentForCentre(product, branchId) {
  const doc = typeof product?.toObject === 'function' ? product.toObject() : { ...(product || {}) };
  const listing = resolveListing(product, branchId);
  return {
    ...doc,
    price: listing.price,
    basePrice: listing.basePrice,
    centrePrice: listing.centrePrice,
    pickupAvailable: listing.pickup,
    // The rows are for the panel; the app only needs the resolution above.
    centreListings: undefined,
  };
}

/**
 * Normalise the panel's rows before saving. Keeps one row per centre, only
 * for centres in `allowed` (the clinic centres), drops anything malformed,
 * and stores a blank price as null (= base price) rather than 0.
 *
 * @param {Array<{branchId:string, branchName?:string, visible?:boolean, price?:number|string|null, pickup?:boolean}>} rows
 * @param {Map<string, {name:string}>} allowed  branchId → branch
 */
function normaliseListings(rows, allowed) {
  if (!Array.isArray(rows)) return [];
  const seen = new Map();
  for (const r of rows) {
    const branchId = idOf(r?.branchId);
    if (!branchId || !allowed.has(branchId)) continue;
    const raw = r.price;
    const n = raw === null || raw === undefined || raw === '' ? null : Number(raw);
    const price = n === null ? null : (Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null);
    seen.set(branchId, {
      branchId,
      branchName: allowed.get(branchId).name,
      visible: r.visible !== false && r.visible !== 'false',
      price,
      pickup: r.pickup !== false && r.pickup !== 'false',
    });
  }
  return [...seen.values()];
}

/**
 * A one-line account of where the product is on sale, for lists and audit
 * notes: "All centres", "Jubilee Hills only", "Hidden everywhere", …
 */
function listingSummary(product, clinics) {
  const names = clinics.map((c) => ({ id: idOf(c._id), name: c.name }));
  const on = names.filter((c) => resolveListing(product, c.id).visible);
  if (on.length === names.length) return 'All centres';
  if (on.length === 0) return 'Hidden everywhere';
  return `${on.map((c) => c.name).join(', ')} only`;
}

module.exports = {
  DEFAULT_LISTING,
  listingRow,
  resolveListing,
  visibleAt,
  priceAt,
  visibleAtFilter,
  presentForCentre,
  normaliseListings,
  listingSummary,
};
