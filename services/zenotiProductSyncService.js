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
const Inventory = require('../models/Inventory');
const Branch = require('../models/Branch');
const zenoti = require('./zenotiService');
const { CENTERS } = require('../config/zenoti');
const logger = require('../utils/logger');
const { findByName } = require('../utils/nameMatch');
const { classifyRx } = require('../utils/rxClassifier');

/** The description a synced product is created with until the panel writes one. */
const SYNC_DESCRIPTION_RX = /^Synced from Zenoti on \d{4}-\d{2}-\d{2}\.$/;

/** Branch documents keyed by the branch name our centre map points at. */
async function branchIndex() {
  const branches = await Branch.find({}).select('name zenotiCenterId centreType').lean();
  const byName = new Map(); const byCentre = new Map();
  for (const b of branches) {
    byName.set(String(b.name || '').trim().toLowerCase(), b);
    if (b.zenotiCenterId) byCentre.set(String(b.zenotiCenterId).toLowerCase(), b);
  }
  return { byName, byCentre };
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

  const { byName, byCentre } = await branchIndex();
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

    // The centre's OWN branch (pharmacies included), not its parent clinic —
    // a pharmacy holds its own range and its own shelf.
    const branch = byCentre.get(norm(centerId)) || byName.get(norm(centre.branchName));
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
        description: row.description || null,
        mrp: row.mrp ?? null,
        packSize: row.packSize || null,
        hsn: row.hsn || null,
        isRetail: row.isRetail === true ? true : row.isConsumable === true ? false : null,
        isActive: truthy(row.isActive),
        barcodes: Array.isArray(row.barcodes) ? row.barcodes : [],
        isKit: row.isKit === true,
        zenotiCategoryId: row.categoryId || null,
        zenotiSubCategoryId: row.raw?.sub_category_id || null,
        isConsumable: row.isConsumable === true,
        centres: [],
        branchStock: [],
        total: 0,
      };
      // Availability: this centre lists the product.
      if (!entry.centres.some((c) => c.zenotiCenterId === centerId)) {
        entry.centres.push({ branchId: branch?._id || null, zenotiCenterId: centerId, branchName: branch?.name || centre.name });
      }
      if (row.isConsumable === true) entry.isConsumable = true;
      if (row.isRetail === true) entry.isRetail = true;
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
      /*
       * Consumables (needles, device supplies) belong in the clinic's
       * Inventory, which the treatment room consumes from — not in the app
       * store's Product list, where 260 of them would be catalogue noise.
       * Retail items go to Product. Stock is never written for either.
       */
      // Consumables keep their legacy Inventory row (the treatment room
      // consumes from it); every product — retail or consumable — also gets a
      // master row below, which is what the panel's product list shows and
      // what the per-centre shelf rows point at.
      if (entry.isRetail !== true) {
        let inv = await Inventory.findOne({ zenotiProductId: entry.zenotiProductId });
        if (!inv && entry.sku) inv = await Inventory.findOne({ code: entry.sku });
        if (!inv) inv = await Inventory.findOne({ inventoryName: entry.name });
        if (inv && inv.zenotiProductId && inv.zenotiProductId !== entry.zenotiProductId) { stats.errors += 1; continue; } // same name, different Zenoti item
        if (!inv) { inv = new Inventory({ inventoryName: entry.name, inventoryCategory: 'Consumables' }); stats.created += 1; } else { stats.updated += 1; }
        inv.zenotiProductId = entry.zenotiProductId;
        if (entry.sku) inv.code = entry.sku;
        if (entry.packSize) inv.formulation = entry.packSize;
        if (entry.brand) inv.orgName = entry.brand;
        // Same rule as the master row: write only on a real change.
        if (inv.isNew || inv.modifiedPaths().some((p) => p !== 'zenotiSyncedAt')) {
          inv.zenotiSyncedAt = new Date();
          await inv.save({ validateModifiedOnly: true });
        }
      }

      let product = await Product.findOne({ zenotiProductId: entry.zenotiProductId });
      if (!product && entry.sku) product = await Product.findOne({ sku: entry.sku });
      if (!product && entry.sku) product = await Product.findOne({ code: entry.sku });
      if (!product) {
        const pool = await Product.find({ zenotiProductId: { $in: [null, ''] } }).select('name').lean();
        const hit = findByName(pool, entry.name);
        if (hit) product = await Product.findById(hit._id);
      }
      // A same-name product already tied to a DIFFERENT Zenoti item is not this item.
      if (product && product.zenotiProductId && product.zenotiProductId !== entry.zenotiProductId) {
        stats.errors += 1;
        logger.warn('Product mirror skipped: name already linked to another Zenoti product', { name: entry.name, zenotiProductId: entry.zenotiProductId });
        continue;
      }

      if (!product) {
        product = new Product({
          // No stock feed from Zenoti: don't let a zero read as sold out.
          trackStock: false,
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
      /*
       * Zenoti's API publishes only the printed MRP — there is no separate
       * "sale price" field on the product feed (verified 2026-09-06). A
       * mirrored product used to land with price 0, which reads as "free" in
       * every list and blocks it from the app. So: when we have no price of
       * our own, adopt the MRP. The panel can change it afterwards and the
       * sync never overwrites a price someone set here.
       */
      if (!(Number(product.price) > 0) && Number(entry.mrp) > 0) {
        product.price = Number(entry.mrp);
        if (!product.priceSource) product.priceSource = 'zenoti-mrp';
      }
      if (entry.packSize) product.packSize = entry.packSize;
      if (entry.hsn) product.hsn = entry.hsn;
      if (entry.isRetail !== null) product.isRetail = entry.isRetail;
      product.productType = entry.isRetail === true ? 'Retail' : entry.isConsumable ? 'Consumable' : product.productType;
      if (entry.centres.length) product.centres = entry.centres;
      if (entry.barcodes?.length) product.barcodes = entry.barcodes;
      if (entry.isKit) product.isKit = true;
      if (entry.zenotiCategoryId) product.zenotiCategoryId = entry.zenotiCategoryId;
      if (entry.zenotiSubCategoryId) product.zenotiSubCategoryId = entry.zenotiSubCategoryId;
      // Zenoti's description is only adopted while ours is the sync
      // placeholder — copy written in the panel is never overwritten.
      if (entry.description && (!product.description || SYNC_DESCRIPTION_RX.test(product.description))) {
        product.description = entry.description;
      }
      // Rx/OTC suggestion for rows nobody has classified yet. A panel decision
      // (rxSource 'manual' or 'import') always stands.
      if (product.isRx === null || product.isRx === undefined || product.rxSource === 'heuristic') {
        const verdict = classifyRx({ name: entry.name, category: entry.productCategory, subCategory: entry.productSubCategory, hsn: entry.hsn });
        if (verdict.isRx !== null) { product.isRx = verdict.isRx; product.rxSource = 'heuristic'; product.rxReason = verdict.reason; }
      }
      if (entry.hasQuantity) {
        product.branchStock = entry.branchStock;
        product.stock = entry.total;
        product.trackStock = true;
      }
      // Otherwise `trackStock` is settled once, below, for rows that have never
      // had it decided — a panel decision (true or false) is never overridden.
      // Only touch the database when a field actually changed — this runs
      // hourly across 700 products and used to rewrite every row every time.
      const changed = product.isNew || product.modifiedPaths().some((p) => p !== 'zenotiSyncedAt');
      if (!changed) { stats.updated -= 1; stats.unchanged = (stats.unchanged || 0) + 1; continue; }
      product.zenotiSyncedAt = new Date();

      await product.save({ validateModifiedOnly: true });
    } catch (error) {
      stats.errors += 1;
      logger.warn('Zenoti product upsert failed', { zenotiProductId: entry.zenotiProductId, error: error.message });
    }
  }

  // Per-centre shelf rows: one Inventory document per product per centre that
  // lists it, so "what is on the shelf at Jubilee Hills Pharmacy" is a query,
  // not a guess. Quantities are ours (Zenoti exposes none) and are never reset.
  try { stats.shelves = await syncCentreShelves(merged, byCentre); }
  catch (error) { logger.warn('Per-centre shelf sync failed', { error: error.message }); }

  // Products mirrored before `trackStock` existed carry no value at all. Zenoti
  // gives no stock, so "never decided" means "not tracked" — set exactly once,
  // and only where the field is absent, so a clinic that later starts counting
  // a product in the panel keeps that choice.
  const settled = await Product.updateMany(
    { zenotiProductId: { $type: 'string' }, trackStock: { $exists: false } },
    { $set: { trackStock: false } },
  ).catch(() => ({ modifiedCount: 0 }));
  stats.stockUntrackedSettled = settled.modifiedCount || 0;

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

/**
 * One Inventory row per (product, centre) — Zenoti's "Current stock" list.
 * Existing quantities, batches and costs are never touched; only identity and
 * linkage are written, and only when something actually changed.
 */
async function syncCentreShelves(merged, byCentre) {
  const Product = require('../models/Product');
  const wanted = [];
  for (const entry of merged.values()) {
    if (!entry.name) continue;
    for (const c of entry.centres || []) {
      if (!c.branchId) continue;
      wanted.push({ zenotiProductId: entry.zenotiProductId, branchId: c.branchId, zenotiCenterId: c.zenotiCenterId, name: entry.name, code: entry.sku || null, category: entry.isRetail === true ? 'Retail products' : 'Consumables', packSize: entry.packSize || null, brand: entry.brand || null, mrp: entry.mrp ?? null, hsn: entry.hsn || null });
    }
  }
  const ids = [...new Set(wanted.map((w) => w.zenotiProductId))];
  const products = await Product.find({ zenotiProductId: { $in: ids } }).select('_id zenotiProductId gstPercentage').lean();
  const productBy = new Map(products.map((p) => [String(p.zenotiProductId), p]));
  const existing = await Inventory.find({ zenotiProductId: { $in: ids } }).select('_id zenotiProductId branchId productId zenotiCenterId inventoryName code inventoryCategory').lean();
  const key = (p, b) => `${p}|${b || 'none'}`;
  const have = new Map(existing.map((e) => [key(e.zenotiProductId, e.branchId), e]));
  // A legacy consumable row with no centre becomes the row for its first centre
  // rather than a duplicate.
  const orphan = new Map(existing.filter((e) => !e.branchId).map((e) => [String(e.zenotiProductId), e]));
  const ops = [];
  const claimed = new Set();
  for (const w of wanted) {
    const hit = have.get(key(w.zenotiProductId, w.branchId));
    const product = productBy.get(String(w.zenotiProductId));
    const set = { productId: product?._id || null, zenotiCenterId: w.zenotiCenterId, branchId: w.branchId, zenotiProductId: w.zenotiProductId, inventoryName: w.name, code: w.code, inventoryCategory: w.category, zenotiSyncedAt: new Date() };
    if (hit) {
      if (hit.productId && String(hit.productId) === String(set.productId) && hit.zenotiCenterId === w.zenotiCenterId && hit.inventoryName === w.name) continue;
      ops.push({ updateOne: { filter: { _id: hit._id }, update: { $set: set } } });
      continue;
    }
    const reuse = !claimed.has(String(w.zenotiProductId)) ? orphan.get(String(w.zenotiProductId)) : null;
    if (reuse) { claimed.add(String(w.zenotiProductId)); ops.push({ updateOne: { filter: { _id: reuse._id }, update: { $set: set } } }); continue; }
    ops.push({ insertOne: { document: { ...set, qohAllBatches: 0, qohBatchWise: 0, batchMaintenance: 'Non Batchable', gstPercentage: product?.gstPercentage ?? 0, packName: w.packSize, orgName: w.brand, createdAt: new Date(), updatedAt: new Date() } } });
  }
  if (!ops.length) return { rows: wanted.length, written: 0 };
  const res = await Inventory.bulkWrite(ops, { ordered: false });
  return { rows: wanted.length, inserted: res.insertedCount || 0, updated: res.modifiedCount || 0 };
}

module.exports = { syncProducts, syncCentreShelves };
