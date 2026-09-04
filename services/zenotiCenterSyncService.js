/**
 * Mirror Zenoti's centres into Branch.
 *
 * Zenoti is where the clinic's address, phone, email and map pin are
 * maintained, so those come FROM Zenoti and overwrite the branch record on
 * every run. Everything Zenoti does not hold — opening hours, closures,
 * photos, description, the app-side display order — is left alone.
 *
 * Only the three CLINIC centres are mirrored (config/zenoti.js decides which
 * centres are clinics); pharmacies and the training centre are not branches a
 * patient can book. Nothing is ever created here: a missing branch is
 * reported, because a branch has hours, a slot policy and staff that a person
 * must set up.
 *
 * The clinic-wide IVR number (AppCustomization.contact.phone), when set, still
 * wins in the app over the per-branch phone mirrored here.
 */
const Branch = require('../models/Branch');
const ZenotiSyncRun = require('../models/ZenotiSyncRun');
const zenoti = require('./zenotiService');
const { CENTERS } = require('../config/zenoti');
const logger = require('../utils/logger');

const norm = (v) => String(v || '').trim().toLowerCase();

/** The schema's street-line field under `address` (named differently across builds). */
function addressLinePath() {
  const paths = Object.keys(Branch.schema.paths).filter((p) => p.startsWith('address.'));
  const known = new Set(['address.city', 'address.state', 'address.pincode', 'address.country']);
  return paths.find((p) => !known.has(p)) || null;
}

async function syncCenters({ trigger = 'schedule', adminId = null } = {}) {
  if (!zenoti.isConfigured()) return { skipped: true };
  const run = await ZenotiSyncRun.create({ type: 'centers', trigger: trigger === 'schedule' ? 'schedule' : 'manual', startedBy: adminId }).catch(() => null);
  const stats = { seen: 0, updated: 0, unchanged: 0, missingBranch: [], failed: 0 };
  try {
    const json = await zenoti.request('/v1/centers', {});
    const centres = json?.centers || (Array.isArray(json) ? json : []);
    const linePath = addressLinePath();

    for (const c of centres) {
      const id = norm(c.id);
      const cfg = CENTERS[c.id] || CENTERS[id];
      if (!cfg || !cfg.isClinic) continue;
      stats.seen += 1;
      try {
        let branch = await Branch.findOne({ zenotiCenterId: id });
        if (!branch) branch = await Branch.findOne({ name: new RegExp(`^${cfg.branchName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
        if (!branch) { stats.missingBranch.push(cfg.branchName); continue; }

        const before = JSON.stringify([branch.zenotiCenterId, branch.address, branch.contact, branch.location?.coordinates]);
        branch.zenotiCenterId = id;

        const addr = c.address_info || {};
        const line = [addr.address_1, addr.address_2].filter((x) => x && String(x).trim()).join(', ');
        if (linePath && line) branch.set(linePath, line);
        if (addr.city) branch.set('address.city', addr.city);
        if (c.state?.name || c.state?.short_name) branch.set('address.state', c.state.name || c.state.short_name);
        if (addr.zip_code) branch.set('address.pincode', String(addr.zip_code));

        const phones = [c.contact_info?.phone_1, c.contact_info?.phone_2].filter((x) => x && String(x).trim()).map(String);
        if (phones.length) branch.set('contact.phone', phones);
        if (c.contact_info?.email) branch.set('contact.email', String(c.contact_info.email).toLowerCase());

        const lat = Number(c.location?.latitude ?? c.location?.lattitude);
        const lng = Number(c.location?.longitude);
        if (Number.isFinite(lat) && Number.isFinite(lng) && (lat || lng)) {
          branch.set('location', { type: 'Point', coordinates: [lng, lat] });
        }

        const after = JSON.stringify([branch.zenotiCenterId, branch.address, branch.contact, branch.location?.coordinates]);
        if (before === after) { stats.unchanged += 1; continue; }
        branch.zenotiSyncedAt = new Date();
        await branch.save({ validateModifiedOnly: true });
        stats.updated += 1;
      } catch (error) {
        stats.failed += 1;
        logger.warn('Centre mirror failed', { centerId: id, error: error.message });
      }
    }
    if (run) await ZenotiSyncRun.updateOne({ _id: run._id }, { $set: { status: 'completed', finishedAt: new Date(), total: stats.seen, updated: stats.updated, skipped: stats.unchanged, failed: stats.failed, datasets: stats } });
    logger.info('Zenoti centre sync finished', { trigger, ...stats });
  } catch (error) {
    if (run) await ZenotiSyncRun.updateOne({ _id: run._id }, { $set: { status: 'failed', finishedAt: new Date(), error: error.message } }).catch(() => {});
    logger.error('Zenoti centre sync failed', { error: error.message });
  }
  return stats;
}

module.exports = { syncCenters };
