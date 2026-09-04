/**
 * Doctor-facing product availability.
 *
 * A dermatologist needs to answer one question — "can I recommend this, and is
 * it in stock here?" — and nothing more. Buying price, selling price, margin,
 * vendor and batch cost are commercially sensitive and must never reach a
 * doctor's browser.
 *
 * That is why this is a separate endpoint with its own projection rather than a
 * flag on the admin product list: hiding a column in the panel still ships the
 * number in the JSON, where anyone can read it in the network tab. Here the
 * price is never selected from Mongo in the first place.
 *
 * GET /api/inventory/availability?search=&branchId=&status=&limit=
 */
const Product = require('../models/Product');
const Inventory = require('../models/Inventory');

/** Never widen this list to anything with a price in it. */
const PRODUCT_FIELDS = [
  'name', 'sku', 'code', 'formulation', 'productType', 'productCategory',
  'brand', 'OrgName', 'image', 'stock', 'branchStock', 'lowStockThreshold',
  'isActive', 'zenotiProductId', 'zenotiSyncedAt', 'trackStock',
].join(' ');

const INVENTORY_FIELDS = [
  'inventoryName', 'code', 'formulation', 'inventoryCategory', 'orgName',
  'qohAllBatches', 'qohBatchWise', 'reOrderLevel', 'branchId', 'isActive',
  'zenotiProductId', 'zenotiSyncedAt',
].join(' ');

/** in stock / low stock / out of stock, from a quantity and its reorder level. */
function stockStatus(quantity, threshold, tracked = true) {
  // No count is kept for this item (mirrored from Zenoti, which exposes no
  // stock). It is orderable; the desk checks the shelf.
  if (tracked === false) return 'available';
  const qty = Number(quantity) || 0;
  const low = Number(threshold) || 0;
  if (qty <= 0) return 'out_of_stock';
  if (low > 0 && qty <= low) return 'low_stock';
  return 'in_stock';
}

/** Quantity at one branch, or the total when no branch is selected. */
function branchQuantity(rows, branchId) {
  if (!branchId) return null;
  const hit = (rows || []).find((r) => String(r.branchId || '') === String(branchId));
  return hit ? Number(hit.quantity) || 0 : 0;
}

exports.getAvailability = async (req, res) => {
  try {
    const { search, branchId, status, limit = 200 } = req.query;
    const cap = Math.min(Number(limit) || 200, 500);

    const filter = { isActive: true };
    if (search && String(search).trim()) {
      const rx = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ name: rx }, { sku: rx }, { code: rx }, { brand: rx }, { OrgName: rx }, { formulation: rx }];
    }

    const [products, consumables] = await Promise.all([
      Product.find(filter).select(PRODUCT_FIELDS).limit(cap).lean(),
      // Clinic consumables live in Inventory, not Product. A dermatologist
      // recommending an in-clinic item needs the same answer.
      Inventory.find({
        ...(search && String(search).trim()
          ? { $or: [
              { inventoryName: new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
              { code: new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
            ] }
          : {}),
        ...(branchId ? { branchId } : {}),
      }).select(INVENTORY_FIELDS).limit(cap).lean(),
    ]);

    const rows = [
      ...products.map((p) => {
        const perBranch = branchQuantity(p.branchStock, branchId);
        const quantity = perBranch === null ? Number(p.stock) || 0 : perBranch;
        return {
          _id: p._id,
          source: 'product',
          name: p.name,
          sku: p.sku || p.code || null,
          category: p.productCategory || null,
          productType: p.productType || null,
          formulation: p.formulation || null,
          brand: p.brand || p.OrgName || null,
          image: p.image || '',
          /** Total across the business. */
          totalQuantity: Number(p.stock) || 0,
          /** At the selected branch; null when no branch was requested. */
          branchQuantity: perBranch,
          quantity,
          status: stockStatus(quantity, p.lowStockThreshold, p.trackStock),
          syncedFromZenoti: Boolean(p.zenotiProductId),
          zenotiSyncedAt: p.zenotiSyncedAt || null,
        };
      }),
      ...consumables.map((i) => {
        const quantity = Number(i.qohAllBatches) || 0;
        return {
          _id: i._id,
          source: 'inventory',
          name: i.inventoryName,
          sku: i.code || null,
          category: i.inventoryCategory || null,
          productType: 'Consumable',
          formulation: i.formulation || null,
          brand: i.orgName || null,
          image: '',
          totalQuantity: quantity,
          branchQuantity: branchId ? quantity : null,
          quantity,
          status: stockStatus(quantity, i.reOrderLevel),
          syncedFromZenoti: Boolean(i.zenotiProductId),
          zenotiSyncedAt: i.zenotiSyncedAt || null,
        };
      }),
    ].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

    const filtered = status ? rows.filter((r) => r.status === status) : rows;

    return res.json({
      success: true,
      count: filtered.length,
      data: filtered,
    });
  } catch (error) {
    console.error('getAvailability failed:', error);
    return res.status(500).json({ success: false, message: 'Could not load product availability' });
  }
};
