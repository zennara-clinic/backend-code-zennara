/**
 * Zenoti vendors → our Vendor list (read-only mirror).
 *
 * The org-level `/v1/vendors` endpoint is the one inventory-adjacent read our
 * API key is allowed (stock, purchase orders and adjustments all answer 401),
 * so this is how the purchasing side of the panel learns who the clinic buys
 * from. Bank details and ratings are ours and are never touched.
 */
const Vendor = require('../models/Vendor');
const zenoti = require('./zenotiService');
const logger = require('../utils/logger');

const clean = (v) => (v === null || v === undefined ? null : String(v).trim() || null);

function phoneOf(v) {
  const w = v.work_phone || {};
  const n = clean(w.number);
  if (!n) return null;
  return w.country_code && String(n).length <= 10 ? `+91 ${n}` : n;
}

async function syncVendors({ trigger = 'manual' } = {}) {
  if (!zenoti.isConfigured()) return { skipped: true };
  const ZenotiSyncRun = require('../models/ZenotiSyncRun');
  const run = await ZenotiSyncRun.create({ type: 'vendors', trigger: trigger === 'schedule' ? 'schedule' : 'manual' }).catch(() => null);
  const stats = { seen: 0, created: 0, updated: 0, unchanged: 0, failed: 0 };
  try {
    const rows = [];
    for (let page = 1; page <= 20; page += 1) {
      const json = await zenoti.request('/v1/vendors', { query: { page, size: 100 } });
      const list = json?.vendors || [];
      rows.push(...list);
      if (list.length < 100) break;
    }
    stats.seen = rows.length;

    for (const v of rows) {
      const id = String(v.id || '').toLowerCase();
      if (!id || !clean(v.name)) continue;
      try {
        let doc = await Vendor.findOne({ zenotiVendorId: id });
        if (!doc) doc = await Vendor.findOne({ name: new RegExp(`^${String(v.name).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
        const isNew = !doc;
        if (!doc) doc = new Vendor({ name: String(v.name).trim() });

        doc.zenotiVendorId = id;
        if (clean(v.code)) doc.code = clean(v.code);
        if (clean(v.name)) doc.name = String(v.name).trim();
        if (clean(v.email) || (v.emails || [])[0]) doc.email = clean(v.email) || clean((v.emails || [])[0]);
        const phone = phoneOf(v);
        if (phone) doc.phone = phone;
        const address = [clean(v.address1), clean(v.address2)].filter(Boolean).join(', ');
        if (address) doc.address = address;
        if (clean(v.city)) doc.city = clean(v.city);
        if (clean(v.zip_code)) doc.pincode = clean(v.zip_code);
        if (clean(v.GST_IN)) doc.gstNumber = clean(v.GST_IN);
        if (clean(v.description) && !doc.notes) doc.notes = clean(v.description);

        if (!isNew && !doc.isModified()) { stats.unchanged += 1; continue; }
        doc.zenotiSyncedAt = new Date();
        await doc.save({ validateModifiedOnly: true });
        stats[isNew ? 'created' : 'updated'] += 1;
      } catch (error) {
        stats.failed += 1;
        if (stats.failed <= 3) logger.warn('Vendor mirror failed', { vendor: v.name, error: error.message });
      }
    }
    logger.info('Zenoti vendor sync finished', { trigger, ...stats });
    if (run) await ZenotiSyncRun.updateOne({ _id: run._id }, { $set: { status: 'completed', finishedAt: new Date(), total: stats.seen, created: stats.created, updated: stats.updated, skipped: stats.unchanged, failed: stats.failed, datasets: stats } });
  } catch (error) {
    logger.error('Zenoti vendor sync failed', { error: error.message });
    if (run) await ZenotiSyncRun.updateOne({ _id: run._id }, { $set: { status: 'failed', finishedAt: new Date(), error: error.message } }).catch(() => {});
    stats.error = error.message;
  }
  return stats;
}

module.exports = { syncVendors };
