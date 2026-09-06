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
        stats.packages.updated += 1;
      } else if (!(await fillPackageFromPurchases(doc, stats))) {
        stats.packages.unchanged += 1;
        continue;
      }
      // A freshly created or newly linked shell also gets its contents from sales.
      if (!(doc.services || []).length || !(Number(doc.price) > 0)) await fillPackageFromPurchases(doc, stats);
      await doc.save({ validateModifiedOnly: true });
    } catch (error) {
      stats.packages.failed += 1;
      logger.warn('Package mirror failed', { zenotiPackageId: pkg.id, name: pkg.name, error: error.message });
    }
  }
  const gone = await Package.find({ zenotiPackageId: { $nin: [...seenIds], $type: 'string' }, isActive: true }).select('name').lean();
  stats.packages.missingFromZenoti = gone.map((g) => g.name);
}

/**
 * Membership plans from Zenoti's centre lists → Membership rows (source
 * 'zenoti'). The API gives name, price, type and images; discount rules and
 * credits are NOT exposed, so they stay editable here and are never
 * overwritten. Nothing is written back to Zenoti.
 */
async function syncMemberships(stats) {
  const Membership = require('../models/Membership');
  const { rows } = await collect((c) => zenoti.getCenterMemberships(c));
  const seen = new Set();
  for (const m of rows) {
    if (!m.id || seen.has(m.id)) continue;
    seen.add(m.id);
    try {
      let doc = await Membership.findOne({ zenotiMembershipId: m.id });
      if (!doc) {
        const code = String(m.name || m.id).toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || m.id.slice(0, 8).toUpperCase();
        const clash = await Membership.findOne({ code }).select('_id').lean();
        doc = new Membership({ name: m.name || 'Membership', code: clash ? `${code}-${m.id.slice(0, 4).toUpperCase()}` : code, prefix: code.replace(/-/g, '').slice(0, 8), source: 'zenoti', zenotiMembershipId: m.id, isActive: m.canBook !== false, description: m.description || '' });
        stats.memberships.created += 1;
      } else stats.memberships.updated += 1;
      doc.zenotiVersionId = m.versionId || doc.zenotiVersionId;
      if (Number(m.price) > 0) doc.price = Number(m.discountedPrice) > 0 ? Number(m.discountedPrice) : Number(m.price);
      if (m.isRecurring === true) doc.membershipType = 'recurring';
      doc.zenotiRaw = { name: m.name, displayName: m.displayName, price: m.price, discountedPrice: m.discountedPrice, membershipType: m.membershipType, isRecurring: m.isRecurring, showPrice: m.showPrice, imagePaths: m.imagePaths };
      doc.zenotiSyncedAt = new Date();
      await doc.save();
    } catch (error) {
      stats.memberships.failed += 1;
      logger.warn('Membership mirror failed', { zenotiMembershipId: m.id, name: m.name, error: error.message });
    }
  }
}

async function syncCatalog({ trigger = 'schedule', adminId = null } = {}) {
  if (!zenoti.isConfigured()) return { skipped: true, reason: 'not configured' };
  const run = await ZenotiSyncRun.create({ type: 'catalog', trigger: trigger === 'schedule' ? 'schedule' : 'manual', startedBy: adminId }).catch(() => null);
  const stats = {
    services: { created: 0, updated: 0, unchanged: 0, failed: 0, missingFromZenoti: [] },
    packages: { created: 0, updated: 0, unchanged: 0, failed: 0, missingFromZenoti: [] },
    memberships: { created: 0, updated: 0, failed: 0 },
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

module.exports = { syncCatalog };
