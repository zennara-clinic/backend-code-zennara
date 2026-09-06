/**
 * Rebuild Commerce › Products from the pharmacy's sheets — and nothing else.
 *
 *   node scripts/rebuildCommerceCatalogue.js --otc "<JH_Retail_Rx_vs_OTC>.xlsx" --template "<AppStock_Import_Template>.xlsx" --backup data/backups/<dir> [--apply]
 *
 * What it does (dry run by default; --apply writes):
 *   1. reads the OTC_Sell_Directly sheet — that list IS the catalogue (218 rows)
 *   2. enriches each row from the App Stock template (prices, GST, stock, re-order,
 *      pack, vendor, status, formulation, brand) and from the pre-wipe backup
 *      (image, real description, Zenoti id, barcodes, popularity)
 *   3. deletes EVERY document in the products collection, and every brand and
 *      formulation — Commerce no longer mirrors Zenoti's master
 *   4. inserts the 218 fresh products; relinks per-centre shelf rows (Inventory.productId)
 *      by Zenoti id / code so the stock side keeps working
 * Nothing here calls Zenoti.
 */
require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const XLSX = require('xlsx');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : d; };
const sheetsOf = (f) => { const wb = XLSX.readFile(f); return wb.SheetNames.map((name) => ({ name, rows: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' }) })); };
const SYNC = /^Synced from Zenoti on \d{4}-\d{2}-\d{2}\.$/;
const up = (v) => String(v || '').trim().toUpperCase();
const low = (v) => String(v || '').trim().toLowerCase();

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const Product = require('../models/Product'); const Brand = require('../models/Brand'); const Formulation = require('../models/Formulation'); const Inventory = require('../models/Inventory');
  const { parseAppStockWorkbook } = require('../utils/appStockTemplate');
  const apply = !!arg('apply', false);
  const backupDir = arg('backup');
  if (!backupDir || backupDir === true || !fs.existsSync(`${backupDir}/products.json`)) { console.error('Pass --backup <dir> containing products.json (run the backup first).'); process.exit(1); }

  const otcSheets = parseAppStockWorkbook(sheetsOf(arg('otc'))).filter((s) => s.classification === 'otc');
  const tplSheets = arg('template') && arg('template') !== true ? parseAppStockWorkbook(sheetsOf(arg('template'))).filter((s) => s.kind === 'template') : [];
  const otc = otcSheets.flatMap((s) => s.rows).filter((r) => r.code || r.name);
  const tpl = new Map(); for (const s of tplSheets) for (const r of s.rows) { if (r.code) tpl.set(up(r.code), r); if (r.name) tpl.set(`N:${low(r.name)}`, r); }
  const snap = JSON.parse(fs.readFileSync(`${backupDir}/products.json`, 'utf8'));
  const snapBy = new Map(); for (const p of snap) { if (p.code) snapBy.set(up(p.code), p); if (p.sku) snapBy.set(up(p.sku), p); snapBy.set(`N:${low(p.name)}`, p); }
  console.log(`OTC rows ${otc.length} · template rows ${tpl.size ? tplSheets.reduce((n, s) => n + s.rows.length, 0) : 0} · backup products ${snap.length}`);

  const docs = []; const seen = new Set(); const missingPrice = []; const fromSnapshot = { image: 0, description: 0, zenoti: 0 };
  for (const r of otc) {
    const key = up(r.code) || `N:${low(r.name)}`;
    if (seen.has(key)) continue; seen.add(key);
    const t = tpl.get(up(r.code)) || tpl.get(`N:${low(r.name)}`) || null;
    const s = snapBy.get(up(r.code)) || snapBy.get(`N:${low(r.name)}`) || null;
    const price = (t && t.price > 0 ? t.price : null) ?? (s && Number(s.price) > 0 ? Number(s.price) : null) ?? (r.mrp > 0 ? r.mrp : null);
    // Price is required by the schema: an unpriced row is kept at 0 and hidden until someone prices it.
    if (!price) missingPrice.push(`${r.code || ''} ${r.name}`);
    const realDesc = s && s.description && !SYNC.test(String(s.description).trim()) ? s.description : null;
    if (s?.image) fromSnapshot.image += 1; if (realDesc) fromSnapshot.description += 1; if (s?.zenotiProductId) fromSnapshot.zenoti += 1;
    const formulation = (t && t.formulation) || r.subCategory || r.category || 'General';
    const brand = (t && t.brand) || (s && (s.brand || (s.OrgName && s.OrgName !== 'Zennara' ? s.OrgName : null))) || null;
    docs.push({
      name: r.name || s?.name, code: r.code || s?.code || s?.sku || null, sku: s?.sku || r.code || null,
      description: realDesc || `${r.name}. ${[r.category, r.subCategory].filter(Boolean).join(' · ')}.`,
      formulation, OrgName: brand || 'Zennara', brand,
      productCategory: r.category || t?.category || null, productSubCategory: r.subCategory || null,
      price: price || 0, mrp: r.mrp ?? s?.mrp ?? null, priceSource: !price ? null : t && t.price > 0 ? 'template' : s && Number(s.price) > 0 ? (s.priceSource || 'panel') : 'zenoti-mrp',
      buyingPrice: t?.buyingPrice ?? null, gstPercentage: t?.gst ?? (Number.isFinite(Number(s?.gstPercentage)) ? Number(s.gstPercentage) : 18),
      hsn: r.hsn || s?.hsn || null, vendorName: (t && t.vendorName) || r.vendorName || null, vendorId: s?.vendorId || null,
      stock: Math.max(0, (t && t.stock !== null ? t.stock : r.stock) ?? 0), trackStock: true, stockSource: 'template', stockUpdatedAt: new Date(),
      reorderLevel: t?.reorderLevel ?? null, lowStockThreshold: t?.reorderLevel ?? 5, targetLevel: t?.targetLevel ?? null,
      packName: t?.packName || null, packSize: t?.packSize ? String(t.packSize) : (s?.packSize || null),
      batchTracking: t?.batchTracking ? (/non/i.test(t.batchTracking) ? 'Non Batchable' : 'Batchable') : 'Non Batchable',
      consumptionOrder: t?.consumptionOrder ? (/exp/i.test(t.consumptionOrder) ? 'ByExpiry' : 'FIFO') : 'FIFO',
      templateStatus: t?.templateStatus || null,
      image: s?.image || '', rating: s?.rating || 0, reviews: s?.reviews || 0, isPopular: !!s?.isPopular,
      isActive: !!price && price > 0, isAppProduct: true, isRetail: true, isRx: false, rxSource: 'import', rxReason: r.reason || 'OTC — sell directly (pharmacy sheet)',
      zenotiProductId: s?.zenotiProductId || null, barcodes: s?.barcodes || [], centres: s?.centres || [], zenotiCategoryId: s?.zenotiCategoryId || null, zenotiSubCategoryId: s?.zenotiSubCategoryId || null,
      productType: 'Retail', zenotiSyncedAt: s?.zenotiSyncedAt || null,
    });
  }
  const cats = new Set(docs.map((d) => d.productCategory).filter(Boolean)); const subs = new Set(docs.map((d) => d.productSubCategory).filter(Boolean)); const brands = new Set(docs.map((d) => d.brand).filter(Boolean)); const forms = new Set(docs.map((d) => d.formulation).filter(Boolean));
  console.log(`\nWILL CREATE ${docs.length} products · live ${docs.filter((d) => d.isActive).length} · without price ${missingPrice.length}${missingPrice.length ? ' → ' + missingPrice.join(' | ') : ''}`);
  console.log(`carried over from backup: image ${fromSnapshot.image} · real description ${fromSnapshot.description} · Zenoti link ${fromSnapshot.zenoti}`);
  console.log(`categories ${cats.size}: ${[...cats].join(', ')}\nsub-categories ${subs.size} · brands ${brands.size} · formulations ${forms.size}`);
  console.log(`stock units ${docs.reduce((n, d) => n + d.stock, 0)} · with HSN ${docs.filter((d) => d.hsn).length} · with vendor ${docs.filter((d) => d.vendorName).length} · with buying price ${docs.filter((d) => d.buyingPrice).length}`);
  console.log(`\nWILL DELETE: products ${await Product.countDocuments()} · brands ${await Brand.countDocuments()} · formulations ${await Formulation.countDocuments()}`);
  if (!apply) { console.log('\nDRY RUN — nothing written. Re-run with --apply.'); await mongoose.disconnect(); return; }

  const del = await Product.deleteMany({}); const delB = await Brand.deleteMany({}); const delF = await Formulation.deleteMany({});
  const inserted = await Product.insertMany(docs, { ordered: false });
  // Relink per-centre shelf rows to the new product ids; the rest point nowhere now.
  await Inventory.updateMany({}, { $set: { productId: null } });
  let relinked = 0;
  for (const p of inserted) {
    const or = []; if (p.zenotiProductId) or.push({ zenotiProductId: p.zenotiProductId }); if (p.code) or.push({ code: p.code });
    if (!or.length) continue;
    const r = await Inventory.updateMany({ $or: or }, { $set: { productId: p._id } }); relinked += r.modifiedCount;
  }
  console.log(`\nAPPLIED: deleted ${del.deletedCount} products, ${delB.deletedCount} brands, ${delF.deletedCount} formulations · inserted ${inserted.length} · shelf rows relinked ${relinked}`);
  console.log(`catalogue now ${await Product.countDocuments({ isAppProduct: true })} · live ${await Product.countDocuments({ isActive: true })} · without photo ${await Product.countDocuments({ $or: [{ image: '' }, { image: null }] })}`);
  await mongoose.disconnect();
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
