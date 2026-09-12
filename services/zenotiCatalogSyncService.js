/**
 * Mirror Zenoti's service and package catalogue into Zennara.
 *
 * Zenoti is the system of record for WHAT the clinic sells; Zennara owns how
 * it is PRESENTED in the app (copy, photos, visibility, and — unless opted in —
 * the displayed price). This job keeps the two aligned without letting either
 * side trample the other:
 *
 *   · READ ONLY against Zenoti. Nothing here writes to it.
 *   · Match by Zenoti id first, then by exact name. A match links the record
 *     (fills zenotiServiceId / zenotiPackageId) so bookings and package sales
 *     can be pushed without anyone mapping it by hand.
 *   · A Zenoti item with no match is CREATED HIDDEN (isActive:false). Nothing
 *     the clinic has not deliberately published ever appears in the app.
 *   · Existing records keep their copy, images, visibility and — by default —
 *     price. Set ZENOTI_SYNC_SERVICE_PRICES=true to let Zenoti's sale price
 *     overwrite the app price on every run.
 *   · Items that vanish from Zenoti are NOT deactivated automatically; they
 *     are listed in the run log for a person to decide.
 */
const Consultation = require('../models/Consultation');
const Package = require('../models/Package');
const ZenotiSyncRun = require('../models/ZenotiSyncRun');
const ZenotiGuestData = require('../models/ZenotiGuestData');
const zenoti = require('./zenotiService');
const { CENTERS } = require('../config/zenoti');
const logger = require('../utils/logger');
const { normalizeName, findByName } = require('../utils/nameMatch');

const norm = (v) => String(v || '').trim().toLowerCase();
const slugify = (v) => norm(v).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const syncPrices = () => String(process.env.ZENOTI_SYNC_SERVICE_PRICES || 'false').toLowerCase() === 'true';

async function uniqueSlug(base, Model) {
  let slug = base || `item-${Date.now()}`;
  let n = 1;
  // eslint-disable-next-line no-await-in-loop
  while (await Model.exists({ slug })) { n += 1; slug = `${base}-${n}`; }
  return slug;
}

/** Collect every clinic centre's services/packages, de-duplicated by Zenoti id. */
async function collect(fetcher) {
  const byId = new Map();
  let centres = 0;
  for (const [centerId, centre] of Object.entries(CENTERS)) {
    if (!centre.isClinic) continue;
    try {
      const rows = await fetcher(centerId);
      centres += 1;
      for (const row of rows) {
        if (!row?.id || !row?.name) continue;
        const cur = byId.get(row.id) || { ...row, centres: [], perCentre: [] };
        cur.centres.push(centre.name);
        // Zenoti prices per centre; keep each centre's figure for centrePrices.
        cur.perCentre.push({ centerId, centreName: centre.name, branchName: centre.branchName, price: row.price ?? null, finalPrice: row.finalPrice ?? null, tax: row.tax ?? null, canBook: row.canBook ?? null });
        // Keep the first non-null value of each field across centres.
        for (const k of Object.keys(row)) if (cur[k] === null || cur[k] === undefined) cur[k] = row[k];
        byId.set(row.id, cur);
      }
    } catch (error) {
      logger.warn('Zenoti catalogue fetch failed for centre', { centerId, error: error.message });
    }
  }
  return { rows: [...byId.values()], centres };
}

/** GST rate implied by Zenoti's price_info (tax over the pre-tax price), rounded to the usual slabs. */
function impliedTaxPercent(svc) {
  const final = Number(svc.finalPrice); const tax = Number(svc.tax);
  if (!(final > 0) || !(tax >= 0)) return null;
  const pct = (tax / (final - tax)) * 100;
  if (!Number.isFinite(pct)) return null;
  const slabs = [0, 5, 12, 18, 28];
  return slabs.reduce((best, s) => (Math.abs(s - pct) < Math.abs(best - pct) ? s : best), slabs[0]);
}

/**
 * Per-centre attributes from the Zenoti row onto our service document.
 * Identity/pricing structure only — price itself follows ZENOTI_SYNC_SERVICE_PRICES.
 */
function applyServiceMaster(doc, svc, branchByName) {
  let changed = false;
  const set = (k, v) => { if (v !== null && v !== undefined && doc[k] !== v) { doc[k] = v; changed = true; } };
  set('code', svc.code || null);
  set('recovery_minutes', Number(svc.recoveryMinutes) >= 0 ? Number(svc.recoveryMinutes) : null);
  set('zenotiCanBook', typeof svc.canBook === 'boolean' ? svc.canBook : null);
  const tax = impliedTaxPercent(svc);
  if (tax !== null && doc.taxPercent !== tax) { doc.taxPercent = tax; doc.priceIncludesTax = true; changed = true; }
  // Per-centre price rows. Only the centres Zenoti lists; a centre the clinic
  // removes from the service in Zenoti drops out here too.
  const rows = [];
  for (const c of svc.perCentre || []) {
    const branch = branchByName.get(norm(c.branchName));
    if (!branch) continue;
    const price = Number(c.finalPrice) >= 0 ? Number(c.finalPrice) : Number(c.price) >= 0 ? Number(c.price) : null;
    if (price === null) continue;
    if (rows.some((r) => String(r.branchId) === String(branch._id))) continue; // pharmacy centres fold onto the clinic
    rows.push({ branchId: branch._id, price, taxPercent: impliedTaxPercent(c) ?? tax ?? null, available: true });
  }
  const before = JSON.stringify((doc.centrePrices || []).map((r) => [String(r.branchId), r.price, r.taxPercent, r.available]));
  const after = JSON.stringify(rows.map((r) => [String(r.branchId), r.price, r.taxPercent, r.available]));
  if (rows.length && before !== after) { doc.centrePrices = rows; changed = true; }
  return changed;
}

async function syncServices(stats) {
  const { rows } = await collect((c) => zenoti.getCenterServices(c));
  const Branch = require('../models/Branch');
  const branchByName = new Map((await Branch.find({}).select('_id name').lean()).map((b) => [norm(b.name), b]));
  const seenIds = new Set();
  for (const svc of rows) {
    seenIds.add(svc.id);
    try {
      let doc = await Consultation.findOne({ zenotiServiceId: svc.id });
      if (!doc) {
        // Normalised match against every UNLINKED service, so "Laser Hair
        // Removal (LHR)" meets Zenoti's "Laser Hair Removal".
        const pool = await Consultation.find({ zenotiServiceId: { $in: [null, ''] } }).select('name zenotiServiceId').lean();
        const hit = findByName(pool, svc.name);
        if (hit) doc = await Consultation.findById(hit._id);
      }
      // Same name, already linked to a different Zenoti service: not this one.
      if (doc && doc.zenotiServiceId && doc.zenotiServiceId !== svc.id) { stats.services.failed += 1; logger.warn('Service mirror skipped: name linked to another Zenoti service', { name: svc.name }); continue; }

      if (!doc) {
        // New to Zennara: create it hidden with the minimum the schema needs.
        // Copy, photos and publishing are the panel's job.
        const slug = await uniqueSlug(slugify(svc.name), Consultation);
        doc = new Consultation({
          id: `consult-${Date.now()}-${stats.services.created + 1}`,
          slug,
          name: svc.name,
          category: svc.categoryName || 'Uncategorised',
          summary: svc.description || `${svc.name} — synced from Zenoti. Add the description in the panel before publishing.`,
          about: svc.description || `${svc.name} is available at ${svc.centres.join(', ')}.`,
          // Tax-inclusive figure when Zenoti gives one, else the sale price.
          price: Number(svc.finalPrice) >= 0 ? Number(svc.finalPrice) : Number(svc.price) >= 0 ? Number(svc.price) : 0,
          duration_minutes: Number(svc.durationMinutes) > 0 ? Number(svc.durationMinutes) : null,
          showPriceInApp: svc.showPrice !== false,
          displayOrder: Number(svc.displayOrder) || 0,
          zenotiServiceId: svc.id,
          isActive: false,
        });
        applyServiceMaster(doc, svc, branchByName);
        stats.services.created += 1;
      } else {
        const before = JSON.stringify([doc.zenotiServiceId, doc.duration_minutes, doc.price]);
        doc.zenotiServiceId = svc.id;
        if (Number(svc.durationMinutes) > 0) doc.duration_minutes = Number(svc.durationMinutes);
        if (syncPrices()) {
          const zp = Number(svc.finalPrice) >= 0 ? Number(svc.finalPrice) : Number(svc.price);
          if (zp >= 0) doc.price = zp;
        }
        const masterChanged = applyServiceMaster(doc, svc, branchByName);
        if (!masterChanged && before === JSON.stringify([doc.zenotiServiceId, doc.duration_minutes, doc.price])) { stats.services.unchanged += 1; continue; }
        stats.services.updated += 1;
      }
      await doc.save({ validateModifiedOnly: true });
    } catch (error) {
      stats.services.failed += 1;
      logger.warn('Service mirror failed', { zenotiServiceId: svc.id, name: svc.name, error: error.message });
    }
  }
  // Linked here, but no longer in Zenoti: report, never deactivate.
  const gone = await Consultation.find({ zenotiServiceId: { $nin: [...seenIds], $type: 'string' }, isActive: true }).select('name').lean();
  stats.services.missingFromZenoti = gone.map((g) => g.name);
}


/**
 * Fill a mirrored package's line items and price from a real sale.
 *
 * Zenoti's catalogue list does not expose which services a package contains,
 * and its detail endpoint refuses our key. But every package a guest has
 * BOUGHT comes through the guest feed with its services and session counts.
 * So for a package we hold as an empty shell, the most recent purchase of the
 * same package is the truth about what is in it — and what it cost.
 *
 * Only fills gaps: a package the panel has already given services or a price
 * is never overwritten.
 */
async function fillPackageFromPurchases(doc, stats) {
  if ((doc.services || []).length && Number(doc.price) > 0) return false;
  const escaped = doc.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const guest = await ZenotiGuestData.findOne({ 'packages.name': new RegExp(`^${escaped}$`, 'i') })
    .sort({ updatedAt: -1 }).select('packages').lean();
  const sale = (guest?.packages || []).find((g) => norm(g?.name) === norm(doc.name));
  if (!sale) return false;

  let changed = false;
  if (!(doc.services || []).length && Array.isArray(sale.services) && sale.services.length) {
    const lines = [];
    for (const svc of sale.services) {
      if (!svc?.name) continue;
      const c = await Consultation.findOne({ name: new RegExp(`^${String(svc.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') })
        .select('id name price').lean();
      if (!c) { stats.packages.unmatchedServices = (stats.packages.unmatchedServices || []).concat(`${doc.name} → ${svc.name}`); continue; }
      lines.push({ serviceId: c.id, serviceName: c.name, servicePrice: c.price || 0, sessions: Math.max(1, Number(svc.total) || 1) });
    }
    if (lines.length) { doc.services = lines; changed = true; }
  }
  if (!(Number(doc.price) > 0) && Number(sale.price) > 0) { doc.price = Number(sale.price); changed = true; }
  if (changed) stats.packages.filledFromSales = (stats.packages.filledFromSales || 0) + 1;
  return changed;
}

async function syncPackages(stats) {
  const { rows } = await collect((c) => zenoti.getCenterPackages(c));
  const Branch = require('../models/Branch');
  const branches = await Branch.find({ zenotiCenterId: { $ne: null } }).select('name zenotiCenterId').lean();
  const branchByCentre = new Map(branches.map((b) => [String(b.zenotiCenterId).toLowerCase(), b]));
  // Which centres list each package (Zenoti's CENTERS tab on a package):
  // `collect` already kept a per-centre row for every package it saw.
  const centresFor = new Map();
  for (const row of rows) {
    const arr = [];
    for (const pc of row.perCentre || []) {
      const b = branchByCentre.get(String(pc.centerId).toLowerCase());
      if (!arr.some((x) => x.zenotiCenterId === pc.centerId)) arr.push({ branchId: b?._id || null, zenotiCenterId: pc.centerId, branchName: b?.name || pc.centreName || '' });
    }
    centresFor.set(row.id, arr);
  }
  const seenIds = new Set();
  for (const pkg of rows) {
    seenIds.add(pkg.id);
    try {
      let doc = await Package.findOne({ zenotiPackageId: pkg.id });
      if (!doc) {
        const pool = await Package.find({ zenotiPackageId: { $in: [null, ''] } }).select('name zenotiPackageId').lean();
        const hit = findByName(pool, pkg.name);
        if (hit) doc = await Package.findById(hit._id);
      }
      if (doc && doc.zenotiPackageId && doc.zenotiPackageId !== pkg.id) { stats.packages.failed += 1; logger.warn('Package mirror skipped: name linked to another Zenoti package', { name: pkg.name }); continue; }

      if (!doc) {
        // A Zenoti package's line items are not exposed by the centre list, so
        // the mirror can only create a hidden shell; the panel adds the
        // sessions and price, then publishes.
        doc = new Package({
          id: `pkg-${Date.now()}-${stats.packages.created + 1}`,
          name: pkg.name,
          description: pkg.description || `${pkg.name} — synced from Zenoti. Add the sessions and price in the panel before publishing.`,
          services: [],
          price: 0,
          zenotiPackageId: pkg.id,
          isActive: false,
          // Zenoti's series validity is stored raw for the panel to read; its
          // unit is not documented, so it is not turned into validityMonths.
          zenotiSeriesTerms: pkg.series || null,
        });
        stats.packages.created += 1;
      } else if (doc.zenotiPackageId !== pkg.id) {
        doc.zenotiPackageId = pkg.id;
      } else {
        await fillPackageFromPurchases(doc, stats);
      }
      // A freshly created or newly linked shell also gets its contents from sales.
      if (!(doc.services || []).length || !(Number(doc.price) > 0)) await fillPackageFromPurchases(doc, stats);
      // The Zenoti master (kind, code, validity, grace, freezes, centres)
      // always applies — it is what makes the catalogue tab meaningful.
      applyPackageMaster(doc, pkg, centresFor.get(pkg.id) || []);
      if (!doc.isNew && !doc.isModified()) { stats.packages.unchanged += 1; continue; }
      if (!doc.isNew) stats.packages.updated += 1;
      await doc.save({ validateModifiedOnly: true });
    } catch (error) {
      stats.packages.failed += 1;
      logger.warn('Package mirror failed', { zenotiPackageId: pkg.id, name: pkg.name, error: error.message });
    }
  }
  const gone = await Package.find({ zenotiPackageId: { $nin: [...seenIds], $type: 'string' }, isActive: true }).select('name').lean();
  stats.packages.missingFromZenoti = gone.map((g) => g.name);
  // Anything linked to Zenoti but not listed by a centre is a sale-only row:
  // a custom package built for one guest, or a retired offer. It keeps its
  // assignments but leaves the sellable catalogue.
  const outOfCatalogue = await Package.updateMany(
    { zenotiPackageId: { $type: 'string', $nin: [...seenIds] } },
    [{ $set: { inCatalogue: false, origin: 'zenoti', packageType: { $cond: [{ $regexMatch: { input: '$name', regex: /^custom package/i } }, 'custom', { $ifNull: ['$packageType', 'series'] }] } } }],
  ).catch(() => ({ modifiedCount: 0 }));
  stats.packages.outOfCatalogue = outOfCatalogue.modifiedCount || 0;
  // Rows created in our own panel.
  await Package.updateMany({ zenotiPackageId: { $in: [null, ''] }, origin: { $ne: 'panel' } }, { $set: { origin: 'panel', inCatalogue: true } }).catch(() => {});
  await Package.updateMany({ 'services.0': { $exists: true }, contentsKnown: { $ne: true } }, { $set: { contentsKnown: true } }).catch(() => {});
}

/**
 * Zenoti prices come back as an object — { sales, tax, final } — not a number,
 * so a bare Number() on it is NaN. Read the amount the guest actually pays.
 */
function zenotiAmount(price) {
  if (price === null || price === undefined) return 0;
  if (typeof price === 'number') return price > 0 ? price : 0;
  const n = Number(price.final ?? price.Final ?? price.sales ?? price.Sales ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * The Zen membership from Zenoti → the ONE Membership row the panel and app
 * sell.
 *
 * Zennara sells a single membership. Zenoti still carries the historical rows
 * it has been sold under (Zen Membership, MVP, MVP-2026, MVP Jh, NEW MVP) plus
 * discount tiers that were never sold (Zennara Essential / Prime / Platinum).
 * Mirroring all of them gave the panel eight plans where the clinic has one,
 * so this now keeps exactly one plan — the app-default "Zen Membership" — and
 * retires every other mirrored row.
 *
 * Name, discounts and credits belong to the panel (App Studio → the
 * membership card, and the plan editor). The PRICE follows App Studio's
 * `priceSource`: 'zenoti' (default) writes the anchor row's list price onto the
 * plan so the stored figure tracks Zenoti — the same figure the app charges
 * via utils/zenMembership — and 'manual' leaves the plan's price alone.
 * Zenoti's rows disagree with each other, so the anchor is the row App Studio
 * names (zenotiMembershipVersionId — the clinic sells "MVP Jh"), and only when
 * none is named do we fall back to the row literally called "Zen Membership".
 */
const ZEN_PLAN_CODE = 'ZEN-MEMBERSHIP';

async function syncMemberships(stats) {
  const Membership = require('../models/Membership');
  const { isZenMembership } = require('../config/zenoti');
  const { rows } = await collect((c) => zenoti.getCenterMemberships(c));

  const zenRows = [];
  const seen = new Set();
  for (const m of rows) {
    if (!m.id || seen.has(m.id)) continue;
    seen.add(m.id);
    if (isZenMembership(m.name) || isZenMembership(m.code)) zenRows.push(m);
  }
  stats.memberships.zenotiRowsMatched = zenRows.map((m) => m.name);

  try {
    // The one plan. Found by app-default first so a rename in the panel sticks.
    let doc = await Membership.findOne({ isAppDefault: true })
      || await Membership.findOne({ code: ZEN_PLAN_CODE });
    if (!doc) {
      doc = new Membership({ name: 'Zen Membership', code: ZEN_PLAN_CODE, prefix: 'ZEN', source: 'zenoti', isAppDefault: true, isActive: true });
      stats.memberships.created += 1;
    } else stats.memberships.updated += 1;
    doc.isAppDefault = true;
    doc.isActive = true;
    // The row App Studio sells (by version id, then product id) is the link;
    // without one, the row literally named "Zen Membership", then whichever
    // zen row the centres list first.
    const card = (await require('../models/AppCustomization').getSettings().catch(() => null))?.membership || {};
    const wantedVersion = String(card.zenotiMembershipVersionId || '').trim().toLowerCase();
    const anchor = (wantedVersion && (
      rows.find((m) => String(m.versionId || '').toLowerCase() === wantedVersion)
      || rows.find((m) => String(m.id || '').toLowerCase() === wantedVersion)
    ))
      || zenRows.find((m) => /^zen membership$/i.test(String(m.name || '').trim())) || zenRows[0] || null;
    if (anchor) {
      doc.zenotiMembershipId = anchor.id;
      doc.zenotiVersionId = anchor.versionId || doc.zenotiVersionId;
      doc.zenotiRaw = {
        name: anchor.name,
        displayName: anchor.displayName,
        code: anchor.code || null,
        durationMonths: anchor.durationMonths ?? null,
        isActive: anchor.isActive ?? null,
        zenotiListPrice: zenotiAmount(anchor.price),
        price: anchor.price,
        discountedPrice: anchor.discountedPrice,
        membershipType: anchor.membershipType,
        isRecurring: anchor.isRecurring,
        showPrice: anchor.showPrice,
        imagePaths: anchor.imagePaths,
        // Every Zenoti row that counts as this one membership, with its list price.
        variants: zenRows.map((m) => ({ id: m.id, versionId: m.versionId || null, code: m.code || null, name: m.name, listPrice: zenotiAmount(m.price) })),
      };
      // The stored plan price tracks Zenoti unless the card is set to manual.
      const zenotiPrice = zenotiAmount(anchor.price);
      if (card.priceSource !== 'manual' && zenotiPrice > 0) doc.price = zenotiPrice;
    }
    doc.zenotiSyncedAt = new Date();
    await doc.save();

    // Everything else Zenoti ever gave us leaves the sellable list. Nothing is
    // deleted — member rows and history stay intact behind "include inactive".
    const retired = await Membership.updateMany(
      { _id: { $ne: doc._id }, source: 'zenoti', isActive: true },
      { $set: { isActive: false, isAppDefault: false } },
    );
    stats.memberships.retired = retired.modifiedCount || 0;
  } catch (error) {
    stats.memberships.failed += 1;
    logger.warn('Zen membership mirror failed', { error: error.message });
  }
}

/**
 * Zenoti's package master onto our row: code, kind, validity, grace, freeze
 * allowance, terms and the centres that sell it. Commercial fields the panel
 * owns (price, description, image, isActive) are never touched here.
 */
function applyPackageMaster(doc, pkg, centres) {
  const raw = pkg.raw || pkg;
  doc.origin = 'zenoti';
  doc.inCatalogue = true;
  if (pkg.code && !doc.code) doc.code = String(pkg.code).toUpperCase();
  const type = raw.type ?? pkg.type;
  doc.packageType = /^custom package/i.test(doc.name || '') ? 'custom' : type === 1 ? 'day' : type === 3 ? 'offer' : 'series';
  if (raw.categoryId) doc.zenotiCategoryId = raw.categoryId;
  const series = raw.series || pkg.series || {};
  const validity = series.validity || {};
  const expiry = Number(validity.expiry);
  if (Number.isFinite(expiry) && expiry > 0) { doc.validityDays = expiry; doc.neverExpires = false; }
  else if (validity.expiry_date === null && (expiry === 0 || expiry === -1)) doc.neverExpires = true;
  const grace = Number(String(validity.grace_period ?? '').replace(/[^\d]/g, ''));
  if (Number.isFinite(grace) && grace > 0) doc.graceDays = grace;
  const freezes = Number(series.freezeCount);
  if (Number.isFinite(freezes) && freezes >= 0) doc.maxFreezes = freezes;
  const instalments = Number(series.schedule?.number_of_instalments);
  if (Number.isFinite(instalments) && instalments > 0 && !doc.minPartialPaymentPercent) doc.minPartialPaymentPercent = Math.round(100 / instalments);
  if (series.terms && !doc.agreementText) doc.agreementText = String(series.terms);
  if (centres.length) doc.centres = centres;
  doc.contentsKnown = (doc.services || []).length > 0;
  return doc;
}

async function syncCatalog({ trigger = 'schedule', adminId = null } = {}) {
  if (!zenoti.isConfigured()) return { skipped: true, reason: 'not configured' };
  const run = await ZenotiSyncRun.create({ type: 'catalog', trigger: trigger === 'schedule' ? 'schedule' : 'manual', startedBy: adminId }).catch(() => null);
  const stats = {
    services: { created: 0, updated: 0, unchanged: 0, failed: 0, missingFromZenoti: [] },
    packages: { created: 0, updated: 0, unchanged: 0, failed: 0, missingFromZenoti: [] },
    memberships: { created: 0, updated: 0, failed: 0, retired: 0, zenotiRowsMatched: [] },
    pricesSynced: syncPrices(),
  };
  try {
    await syncServices(stats);
    await syncPackages(stats);
    await syncMemberships(stats).catch((e) => logger.warn('Membership mirror skipped', { error: e.message }));
    if (run) {
      await ZenotiSyncRun.updateOne({ _id: run._id }, { $set: {
        status: 'completed', finishedAt: new Date(),
        created: stats.services.created + stats.packages.created,
        updated: stats.services.updated + stats.packages.updated,
        skipped: stats.services.unchanged + stats.packages.unchanged,
        failed: stats.services.failed + stats.packages.failed,
        datasets: stats,
      } });
    }
    logger.info('Zenoti catalogue sync finished', { trigger, ...stats });
  } catch (error) {
    if (run) await ZenotiSyncRun.updateOne({ _id: run._id }, { $set: { status: 'failed', finishedAt: new Date(), error: error.message } }).catch(() => {});
    logger.error('Zenoti catalogue sync failed', { error: error.message });
  }
  return stats;
}

module.exports = { syncCatalog, syncMemberships };
