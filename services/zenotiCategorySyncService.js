/**
 * Mirror Zenoti's category list into Category.
 *
 * Zenoti holds one flat list of categories for this account (22 on
 * 2026-09-04, no sub-categories — verified live). Services do not carry a
 * category id on their rows, so this cannot FILE services; what it does is
 * keep the two category lists in step and linked by id, so the panel's
 * category picker offers Zenoti's names and a booking can be reported against
 * Zenoti's grouping.
 *
 * Read-only against Zenoti. Match by Zenoti id, then exact name. A Zenoti
 * category with no match is created HIDDEN; nothing existing is renamed,
 * reordered, or deactivated.
 */
const Category = require('../models/Category');
const ZenotiSyncRun = require('../models/ZenotiSyncRun');
const zenoti = require('./zenotiService');
const { CENTERS } = require('../config/zenoti');
const logger = require('../utils/logger');

const slugify = (v) => String(v || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const escapeRx = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function fetchCategories() {
  const byId = new Map();
  for (const [centerId, c] of Object.entries(CENTERS)) {
    if (!c.isClinic) continue;
    try {
      const json = await zenoti.request(`/v1/centers/${centerId}/categories`, { query: { type: 'service', size: 200 } });
      for (const row of json?.categories || []) {
        const id = String(row.id || '').toLowerCase();
        if (!id || !row.name) continue;
        if (!byId.has(id)) byId.set(id, { id, name: String(row.name).trim(), code: row.code || '', description: row.description || '', displayOrder: row.display_order, parentId: row.parent_category_id || null });
      }
    } catch (error) {
      logger.warn('Zenoti categories fetch failed', { centerId, error: error.message });
    }
  }
  return [...byId.values()];
}

async function syncCategories({ trigger = 'schedule', adminId = null } = {}) {
  if (!zenoti.isConfigured()) return { skipped: true };
  const run = await ZenotiSyncRun.create({ type: 'categories', trigger: trigger === 'schedule' ? 'schedule' : 'manual', startedBy: adminId }).catch(() => null);
  const stats = { seen: 0, created: 0, linked: 0, unchanged: 0, failed: 0 };
  try {
    const rows = await fetchCategories();
    for (const cat of rows) {
      stats.seen += 1;
      try {
        let doc = await Category.findOne({ zenotiCategoryId: cat.id });
        if (!doc) doc = await Category.findOne({ name: new RegExp(`^${escapeRx(cat.name)}$`, 'i') });
        if (!doc) {
          let slug = slugify(cat.name) || `category-${Date.now()}`;
          let n = 1;
          // eslint-disable-next-line no-await-in-loop
          while (await Category.exists({ slug })) { n += 1; slug = `${slugify(cat.name)}-${n}`; }
          doc = new Category({
            name: cat.name, slug,
            description: cat.description,
            displayOrder: Number(cat.displayOrder) || 0,
            zenotiCategoryId: cat.id,
            isActive: false,
          });
          stats.created += 1;
        } else if (doc.zenotiCategoryId !== cat.id) {
          doc.zenotiCategoryId = cat.id;
          stats.linked += 1;
        } else {
          stats.unchanged += 1;
          continue;
        }
        await doc.save({ validateModifiedOnly: true });
      } catch (error) {
        stats.failed += 1;
        logger.warn('Category mirror failed', { zenotiCategoryId: cat.id, name: cat.name, error: error.message });
      }
    }
    if (run) await ZenotiSyncRun.updateOne({ _id: run._id }, { $set: { status: 'completed', finishedAt: new Date(), total: stats.seen, created: stats.created, updated: stats.linked, skipped: stats.unchanged, failed: stats.failed, datasets: stats } });
    logger.info('Zenoti category sync finished', { trigger, ...stats });
  } catch (error) {
    if (run) await ZenotiSyncRun.updateOne({ _id: run._id }, { $set: { status: 'failed', finishedAt: new Date(), error: error.message } }).catch(() => {});
    logger.error('Zenoti category sync failed', { error: error.message });
  }
  return stats;
}

module.exports = { syncCategories };
