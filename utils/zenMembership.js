/**
 * The Zen membership's commercial facts — ONE authority.
 *
 * The clinic sells a single membership (₹1,35,000, sold in Zenoti as "MVP Jh",
 * code MVPJH). Its price used to live in four places that only agreed by
 * accident: App Studio's `priceInr`, the panel's Membership plan row, the
 * Zenoti catalogue, and a 135000 literal in the payment controller. The app
 * card, the panel plan list and Razorpay must all show and charge the SAME
 * figure, so every one of them now reads it from resolveZenPricing() here.
 *
 * Where the figure comes from (re-probed live 2026-09-14): Zenoti's centre
 * membership catalogue carries `price.final` for each Zen-family row, plus
 * `htmlBenefits`, `terms` and `description` fields — all three currently null
 * on every Zen row, and isActive false with durationMonths 0. So Zenoti is
 * the authority for the PRICE, and for the inclusions TOO whenever somebody
 * fills them in there; App Studio supplies only what Zenoti leaves empty.
 *
 * Rules:
 *   · Zenoti is the price. A configured zenotiMembershipVersionId + working
 *     credentials → the catalogue row's final price, source 'zenoti'.
 *   · The hand-typed `priceInr` is NOT a price source any more. If Zenoti
 *     cannot be read we serve the LAST price Zenoti gave us (source
 *     'zenoti-cached') rather than a different number nobody agreed to; with
 *     nothing cached the membership reports itself unavailable (amount 0,
 *     source 'unavailable') and the sale is refused. Charging a stale typed
 *     figure because a CRM was briefly down is how a guest pays a price the
 *     clinic stopped selling.
 *   · Copy, benefits and terms prefer Zenoti's own when present.
 *   · Cached in-process for five minutes so a guest who sees ₹X on the card is
 *     charged ₹X a minute later; `fresh:true` (the panel's "refresh price")
 *     bypasses it and drops zenotiService's hour-long catalogue cache too.
 */
const zenoti = require('../services/zenotiService');
const { CENTERS, DEFAULT_BRANCH_NAME, isZenMembership } = require('../config/zenoti');

const FIVE_MINUTES = 5 * 60 * 1000;
/** Kept for older call sites that import it; never used as a price. */
const FALLBACK_PRICE_INR = 135000;
const FALLBACK_NAME = 'Zen Membership';

/*
 * The last price Zenoti actually gave us, for the life of the process.
 *
 * A CRM that is briefly unreachable must not change what a guest is charged.
 * This is the only thing allowed to stand in, and it is still a Zenoti figure
 * — just an older one — which is why it is reported as 'zenoti-cached' rather
 * than passed off as live.
 */
let lastZenotiPrice = null;

/*
 * Everything that touches the database or Zenoti goes through `deps`, so the
 * fallback logic can be tested without either (tests/membership.test.js
 * overrides these). Production never replaces them.
 */
const deps = {
  settings: async () => require('../models/AppCustomization').getSettings(),
  catalog: (centerId) => zenoti.getCenterMemberships(centerId),
  configured: () => zenoti.isConfigured(),
  forgetCatalog: (prefix) => zenoti.forgetCatalog(prefix),
};

let cache = { at: 0, value: null };

/** Numeric rupees out of Zenoti's price object ({ sales, tax, final }) or a bare number. */
function zenotiAmount(price) {
  if (price === null || price === undefined) return 0;
  if (typeof price === 'number') return price > 0 ? price : 0;
  const n = Number(price.final ?? price.Final ?? price.sales ?? price.Sales ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** The clinic centre whose catalogue we read. Org-wide catalogue, so Jubilee Hills is fine. */
function clinicCenterId() {
  const clinics = Object.entries(CENTERS).filter(([, c]) => c.isClinic);
  const def = clinics.find(([, c]) => c.branchName === DEFAULT_BRANCH_NAME);
  return (def || clinics[0] || [null])[0];
}

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const str = (v) => (v === null || v === undefined ? '' : String(v));

/** Pick the configured row: Zenoti's version_id first (what the sale is invoiced against), then the product id. */
function findVariant(rows, versionId) {
  const wanted = String(versionId || '').trim().toLowerCase();
  if (!wanted || !Array.isArray(rows)) return null;
  return rows.find((r) => String(r?.versionId || '').toLowerCase() === wanted)
    || rows.find((r) => String(r?.id || '').toLowerCase() === wanted)
    || null;
}

/**
 * Zenoti writes benefits as HTML. Turn that into the plain lines the card
 * shows — one per list item or paragraph — and drop anything that is markup.
 */
function benefitsFromHtml(html) {
  const raw = str(html).trim();
  if (!raw) return [];
  return raw
    .split(/<\/(?:li|p|div|h[1-6])>|<br\s*\/?>/i)
    .map((chunk) => chunk.replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((title) => ({ title, copy: '' }));
}

/** Zenoti copy with its markup taken off. */
const plain = (v) => str(v).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();

async function resolveZenPricing({ fresh = false } = {}) {
  if (!fresh && cache.value && Date.now() - cache.at < FIVE_MINUTES) return cache.value;

  let m = {};
  try { m = (await deps.settings())?.membership || {}; } catch { m = {}; }

  const out = {
    // Filled in from Zenoti below. There is no hand-typed price any more.
    amount: 0,
    currency: str(m.currency).trim() || 'INR',
    source: 'unavailable',
    zenotiListPrice: null,
    zenotiName: str(m.zenotiMembershipName).trim() || null,
    zenotiCode: null,
    zenotiVersionId: str(m.zenotiMembershipVersionId).trim().toLowerCase() || null,
    zenotiIsActive: null,
    validityMonths: num(m.durationMonths) > 0 ? num(m.durationMonths) : 12,
    discountPercent: num(m.discountPercent, 15),
    taxPercent: num(m.taxPercent, 0),
    basePriceInr: num(m.basePriceInr, 0),
    salePriceInr: num(m.salePriceInr, 0),
    renewalPriceInr: num(m.renewalPriceInr, 0),
    name: str(m.name).trim() || FALLBACK_NAME,
    tagline: str(m.tagline).trim(),
    description: str(m.description).trim(),
    benefits: (Array.isArray(m.benefits) ? m.benefits : [])
      .filter((b) => b && str(b.title).trim())
      .map((b) => ({ title: str(b.title).trim(), copy: str(b.copy).trim() })),
    terms: str(m.terms).trim(),
    /** Where each piece of copy came from — 'zenoti' once Zenoti carries any. */
    benefitsSource: 'manual',
    termsSource: 'manual',
    descriptionSource: 'manual',
    isActive: m.isActive !== false,
    image: str(m.image).trim(),
    ctaText: str(m.ctaText).trim(),
  };

  const canAskZenoti = !!out.zenotiVersionId && (() => { try { return !!deps.configured(); } catch { return false; } })();
  if (canAskZenoti) {
    try {
      if (fresh) { try { deps.forgetCatalog('memberships:'); } catch { /* cache is best-effort */ } }
      const rows = await deps.catalog(clinicCenterId());
      const row = findVariant(rows, out.zenotiVersionId);
      if (row) {
        const price = zenotiAmount(row.price);
        out.zenotiListPrice = price || null;
        out.zenotiName = str(row.name).trim() || out.zenotiName;
        out.zenotiCode = str(row.code).trim() || null;
        out.zenotiIsActive = typeof row.isActive === 'boolean' ? row.isActive : null;
        // A zero price is a misconfigured row, not a free membership.
        if (price > 0) { out.amount = price; out.source = 'zenoti'; lastZenotiPrice = price; }

        /*
         * Zenoti's own words win wherever it has any.
         *
         * The clinic asked for the inclusions to come from Zenoti. All three
         * fields are null there today, so App Studio still supplies them —
         * but the moment somebody writes them in Zenoti they reach the app,
         * the panel and the card with no deploy and no second edit.
         */
        const zBenefits = benefitsFromHtml(row.htmlBenefits ?? row.raw?.htmlBenefits);
        if (zBenefits.length) { out.benefits = zBenefits; out.benefitsSource = 'zenoti'; }
        const zTerms = plain(row.terms ?? row.raw?.terms);
        if (zTerms) { out.terms = zTerms; out.termsSource = 'zenoti'; }
        const zDesc = plain(row.description ?? row.raw?.description);
        if (zDesc) { out.description = zDesc; out.descriptionSource = 'zenoti'; }
        const zMonths = num(row.durationMonths ?? row.raw?.durationMonths);
        if (zMonths > 0) out.validityMonths = zMonths;
      }
    } catch (_) {
      // Fall through to the last Zenoti figure below — never to a typed one.
    }
  }

  if (out.source !== 'zenoti' && num(lastZenotiPrice) > 0) {
    out.amount = num(lastZenotiPrice);
    out.source = 'zenoti-cached';
  }

  cache = { at: Date.now(), value: out };
  return out;
}

/** The price block on its own — what the panel's plan list attaches as `live`. */
function pricingSummary(p) {
  if (!p) return null;
  const { name, tagline, description, benefits, terms, image, ctaText, ...rest } = p;
  return rest;
}

/** Every Zen-family catalogue row (by name or code), de-duplicated across the clinic centres — for pickers. */
async function zenVariants() {
  const byId = new Map();
  for (const [centerId, c] of Object.entries(CENTERS)) {
    if (!c.isClinic) continue;
    let rows = [];
    try { rows = await deps.catalog(centerId); } catch { rows = []; }
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r?.id || byId.has(r.id)) continue;
      if (isZenMembership(r.name) || isZenMembership(r.code)) byId.set(r.id, r);
    }
  }
  return [...byId.values()];
}

/** The single Membership plan document — the same lookup the Zenoti mirror uses, so there is never a second plan. */
async function zenPlanRow() {
  return require('../services/zenotiMembershipMirror').zenPlan();
}

/** Forget the five-minute figure AND the last Zenoti price (tests, and after the panel edits the card). */
function resetPricingCache() {
  cache = { at: 0, value: null };
  lastZenotiPrice = null;
}

module.exports = {
  resolveZenPricing,
  pricingSummary,
  zenVariants,
  zenPlanRow,
  zenotiAmount,
  findVariant,
  resetPricingCache,
  FALLBACK_PRICE_INR,
  FALLBACK_NAME,
  _deps: deps,
};
