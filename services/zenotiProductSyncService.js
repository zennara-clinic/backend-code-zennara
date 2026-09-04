/**
 * Mirror the Zenoti retail catalogue and its per-centre stock into Product.
 *
 * Zenoti is the system of record for what the clinic sells and how much of it
 * is on the shelf. Before this, `Product.stock` was maintained only by the app
 * store's own decrements, so the number a dermatologist saw had no relationship
 * to the pharmacy shelf.
 *
 * Deliberate constraints:
 *
 *   · READ ONLY. Nothing here ever writes to Zenoti. Stock corrections belong
 *     in Zenoti or in a purchase-order receipt, never in a mirror.
 *   · It never creates an app-store listing. A synced product arrives
 *     `isActive: false` with price 0 and has to be published deliberately in
 *     the panel — otherwise a Zenoti catalogue import would silently put
 *     hundreds of unpriced items in front of customers.
 *   · It never overwrites commercial fields (price, gstPercentage, image,
 *     description, isActive). Those are Zennara's, set in the panel. Only
 *     identity and attributes (brand, category, MRP, pack size, HSN) come from
 *     Zenoti. STOCK IS NOT IN THIS FEED (verified 2026-09-04) — see
 *     zenotiService.getCenterProducts — so stock is never written from here.
 *   · Matching is by zenotiProductId, then by SKU/code, then by exact name.
 *     Anything else risks merging two different products.
 */
const Product = require('../models/Product');
const Branch = require('../models/Branch');
const zenoti = require('./zenotiService');
const { CENTERS } = require('../config/zenoti');
const logger = require('../utils/logger');

/** Branch documents keyed by the branch name our centre map points at. */
async function branchIndex() {
  const branches = await Branch.find({}).select('name').lean();
  const byName = new Map();
  for (const b of branches) byName.set(String(b.name || '').trim().toLowerCase(), b);
  return byName;
}

const norm = (v) => String(v || '').trim().toLowerCase();

/** Zenoti's active flag arrives as a boolean, 1/0 or a string. */
function truthy(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'active'].includes(s)) return true;
  if (['0', 'false', 'no', 'inactive'].includes(s)) return false;
  return null;
}

/**
 * Pull every centre's products and fold them into Product documents.
 *
 * @returns {Promise<{centres:number, seen:number, created:number, updated:number, errors:number}>}
 */
async function syncProducts({ trigger = 'manual' } = {}) {
  if (!zenoti.isConfigured()) {
    logger.info('Zenoti product sync skipped (integration not configured)');
    return { centres: 0, seen: 0, created: 0, updated: 0, errors: 0, skipped: true };
  }

  const ZenotiSyncRun = require('../models/ZenotiSyncRun');
  const run = await ZenotiSyncRun.create({ type: 'products', trigger: trigger === 'schedule' ? 'schedule' : 'manual' }).catch(() => null);

  const byName = await branchIndex();
  const stats = { centres: 0, seen: 0, created: 0, updated: 0, errors: 0 };

  /** zenotiProductId → the row we are assembling across every centre. */
  const merged = new Map();

  for (const [centerId, centre] of Object.entries(CENTERS)) {
    let rows = [];
    try {
      rows = await zenoti.getCenterProducts(centerId);
    } catch (error) {
      stats.errors += 1;
      logger.warn('Zenoti product list failed for centre', { centerId, error: error.message });
      continue;
    }
    stats.centres += 1;

    const branch = byName.get(norm(centre.branchName));
    for (const row of rows) {
      if (!row?.id) continue;
      stats.seen += 1;
      const key = String(row.id);
      const entry = merged.get(key) || {
        zenotiProductId: key,
        name: row.name || null,
        sku: row.code || null,
        brand: row.brand || null,
        productCategory: row.category || null,
        productSubCategory: row.subCategory || null,
        productType: row.productType || null,
        formulation: row.packSize || null,
        mrp: row.mrp ?? null,
        packSize: row.packSize || null,
        hsn: row.hsn || null,
        isRetail: row.isRetail === true ? true : row.isConsumable === true ? false : null,
        isActive: truthy(row.isActive),
        branchStock: [],
        total: 0,
      };
      // A later centre may carry a field an earlier one omitted.
      entry.name = entry.name || row.name || null;
      entry.sku = entry.sku || row.code || null;
      entry.brand = entry.brand || row.brand || null;
      entry.productCategory = entry.productCategory || row.category || null;
      entry.productType = entry.productType || row.productType || null;
      entry.formulation = entry.formulation || row.formulation || null;

      // Only a NUMERIC quantity counts. Zenoti's product list does not carry
      // stock for every account; treating "absent" as 0 would zero the app
      // store's stock for every matched product on the first run and show
      // every item as out of stock. Absent quantities leave stock untouched.
      // Stock on hand is not in this feed (verified 2026-09-04); `quantity` is
      // the pack size. Only an explicit stockOnHand number ever touches stock.
      const qty = Number(row.stockOnHand);
      const hasQuantity = row.stockOnHand !== null && row.stockOnHand !== undefined && Number.isFinite(qty) && qty >= 0;
      if (hasQuantity) {
        entry.branchStock.push({
          branchId: branch?._id || null,
          zenotiCenterId: centerId,
          branchName: centre.name,
          quantity: qty,
        });
        entry.total += qty;
        entry.hasQuantity = true;
      }
      merged.set(key, entry);
    }
  }

  for (const entry of merged.values()) {
    if (!entry.name) continue;
    try {
      // Match by Zenoti id, then SKU, then exact name — in that order, because
      // anything looser risks folding two different products together.
      let product = await Product.findOne({ zenotiProductId: entry.zenotiProductId });
      if (!product && entry.sku) product = await Product.findOne({ sku: entry.sku });
      if (!product && entry.sku) product = await Product.findOne({ code: entry.sku });
      if (!product) product = await Product.findOne({ name: entry.name });

      if (!product) {
        product = new Product({
          name: entry.name,
          // Required by the schema, and meaningless until the panel fills them
          // in. A synced product is a stock record first and a listing second.
          description: `Synced from Zenoti on ${new Date().toISOString().slice(0, 10)}.`,
          formulation: entry.formulation || 'Not specified',
          OrgName: entry.brand || 'Zennara',
          price: 0,
          gstPercentage: 18,
          // Never publish automatically — see the header note.
          isActive: false,
        });
        stats.created += 1;
      } else {
        stats.updated += 1;
      }

      // Identity and stock only. Price, GST, image, description and isActive
      // stay exactly as the panel left them.
      product.zenotiProductId = entry.zenotiProductId;
      if (entry.sku) product.sku = entry.sku;
      if (entry.brand) product.brand = entry.brand;
      if (entry.productCategory) product.productCategory = entry.productCategory;
      if (entry.productSubCategory) product.productSubCategory = entry.productSubCategory;
      if (entry.productType) product.productType = entry.productType;
      if (entry.mrp !== null) product.mrp = entry.mrp;
      if (entry.packSize) product.packSize = entry.packSize;
      if (entry.hsn) product.hsn = entry.hsn;
      if (entry.isRetail !== null) product.isRetail = entry.isRetail;
      if (entry.hasQuantity) {
        product.branchStock = entry.branchStock;
        product.stock = entry.total;
      }
      product.zenotiSyncedAt = new Date();

      await product.save({ validateModifiedOnly: true });
    } catch (error) {
      stats.errors += 1;
      logger.warn('Zenoti product upsert failed', { zenotiProductId: entry.zenotiProductId, error: error.message });
    }
  }

  logger.info('Zenoti product sync finished', { ...stats, trigger });
  if (run) {
    await ZenotiSyncRun.updateOne(
      { _id: run._id },
      { $set: {
        status: stats.errors && !stats.updated && !stats.created ? 'failed' : 'completed',
        finishedAt: new Date(),
        total: stats.seen, processed: stats.created + stats.updated,
        created: stats.created, updated: stats.updated, failed: stats.errors,
        datasets: { centres: stats.centres },
      } },
    ).catch(() => {});
  }
  return stats;
}

module.exports = { syncProducts };
