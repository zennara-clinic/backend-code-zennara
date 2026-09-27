/**
 * Replace the Commerce catalogue with a catalogue file.
 *
 *   node scripts/replaceCatalogue.js --catalogue data/catalogue/<file>.json [--apply] [--sellable]
 *
 * Dry run by default: it prints exactly what would happen and writes nothing.
 * `--apply` does it.
 *
 * What it does, in order:
 *   1. reads the catalogue file and validates every row against the Product
 *      schema BEFORE anything is touched — one bad row stops the run
 *   2. carries the clinic's own record across for a product that is in both
 *      catalogues (same product, matched strictly by name): its Zenoti id and
 *      code, so the shelf rows stay attached, and its price, GST, HSN, stock,
 *      vendor, photo and centre listings, which are the clinic's own figures
 *   3. seeds the Bestsellers shelf from what the clinic has actually sold
 *   4. backs up products, formulations, brands and the Inventory links to
 *      data/backups/catalogue-<time>/ (JSON, git-ignored)
 *   5. copies every current product, whole and under its own id, into
 *      `products_archive` — counter sales of those products keep being
 *      recorded against it (services/zenotiAssignmentMirror.js)
 *   6. empties `products`, inserts the new catalogue, re-points the Inventory
 *      shelf rows, and rebuilds the formulation register — steps 5 and 6 in
 *      one transaction, so a failure leaves the old catalogue in place
 *
 * `--sellable` loads the new products with no stock count, which puts them on
 * sale at once. Without it they are counted at zero: the app lists them with
 * their price and page, and sells one only after its stock is entered.
 *
 * NOTHING HERE TALKS TO ZENOTI. No Zenoti module is loaded and no request is
 * made; Zenoti's products, stock and sales are exactly as they were.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : d; };
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

/** The clinic's own figures for a product it already sold. The new page (copy, categories, concerns) always wins. */
const CARRIED = [
  'code', 'sku', 'zenotiProductId', 'zenotiCategoryId', 'zenotiSubCategoryId', 'zenotiSyncedAt', 'barcodes', 'centres', 'branchStock',
  'price', 'mrp', 'priceSource', 'gstPercentage', 'hsn', 'buyingPrice', 'vendorName', 'vendorId',
  'stock', 'trackStock', 'stockSource', 'stockUpdatedAt', 'reorderLevel', 'targetLevel', 'lowStockThreshold',
  'packName', 'batchTracking', 'consumptionOrder', 'templateStatus', 'centreListings', 'image', 'isRx', 'rxSource', 'rxReason',
];
/** Schedule H actives, as whole words, for reading an ingredient list. */
const RX_INGREDIENT_RX = /\b(minoxidil|finasteride|isotretinoin|tretinoin|adapalene|clindamycin|ketoconazole|luliconazole|terbinafine|itraconazole|mometasone|clobetasol|betamethasone|tacrolimus|hydroquinone|benzoyl\s*peroxide|spironolactone)\b/i;
const BESTSELLER_MIN_UNITS = 2;
const BESTSELLER_MAX = 12;

(async () => {
  const file = arg('catalogue');
  if (!file || file === true || !fs.existsSync(file)) { console.error('Pass --catalogue <file.json>'); process.exit(1); }
  const apply = !!arg('apply', false);
  const sellable = !!arg('sellable', false);

  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const Product = require('../models/Product');
  const ArchivedProduct = require('../models/ArchivedProduct');
  const Formulation = require('../models/Formulation');
  const Brand = require('../models/Brand');
  const Inventory = require('../models/Inventory');
  const { buildMatcher } = require('../utils/catalogueMatch');
  const { RX_NAME_RX } = require('../utils/rxClassifier');
  const taxonomy = require('../utils/productTaxonomy');
  const { syncFormulationsFromProducts } = require('../utils/formulations');

  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  const batch = rows[0]?.catalogueSource || path.basename(file, '.json');
  console.log(`database ${db.databaseName} · catalogue ${path.basename(file)} · ${rows.length} rows · batch "${batch}"`);

  const old = await Product.find({}).lean();
  const strict = buildMatcher(rows, (r) => r.name, { strict: true });
  const bare = (r) => (r.brand && r.name.toLowerCase().startsWith(`${r.brand.toLowerCase()} `) ? r.name.slice(r.brand.length).trim() : r.name);
  const strictBare = buildMatcher(rows, bare, { strict: true });
  const same = new Map(); // slug → the old product that is the same product
  for (const o of old) {
    const hit = strict(o.name) || strictBare(o.name);
    if (!hit) continue;
    // Two old rows naming one new product: neither is carried, a person decides.
    same.set(hit.slug, same.has(hit.slug) ? null : o);
  }

  /*
   * Bestsellers, from the clinic's own sales: every order line that names a
   * product in the new catalogue. Cancelled and refunded orders do not count.
   */
  const sold = await db.collection('productorders').aggregate([
    { $match: { orderStatus: { $nin: ['Cancelled', 'Refunded', 'Returned'] } } },
    { $unwind: '$items' },
    { $group: { _id: '$items.productName', units: { $sum: '$items.quantity' } } },
  ]).toArray();
  const loose = buildMatcher(rows);
  const units = new Map();
  for (const s of sold) {
    const hit = s._id && (strict(s._id) || strictBare(s._id) || loose(s._id));
    if (hit) units.set(hit.slug, (units.get(hit.slug) || 0) + (Number(s.units) || 0));
  }
  const best = new Set([...units.entries()].filter(([, n]) => n >= BESTSELLER_MIN_UNITS).sort((a, b) => b[1] - a[1]).slice(0, BESTSELLER_MAX).map(([slug]) => slug));

  const docs = [];
  const problems = [];
  const rx = [];
  const carried = [];
  for (const row of rows) {
    const { _rxText, ...doc } = row;
    doc.trackStock = !sellable;
    const was = same.get(doc.slug);
    if (was) {
      for (const k of CARRIED) if (was[k] !== undefined && was[k] !== null && !(Array.isArray(was[k]) && !was[k].length) && was[k] !== '') doc[k] = was[k];
      carried.push(`${was.name} [${was.code || '—'}] → ${doc.name} · ₹${doc.price} · stock ${doc.stock}`);
    }
    /*
     * A named Schedule H ingredient is never sold through the app. The name is
     * read with the clinic's own classifier; the ingredient list with whole
     * words only, because "doxy" is inside every "hydroxy…". Tranexamic acid
     * counts when it is swallowed — a tablet — not in a serum.
     */
    if (doc.isRx === undefined || doc.isRx === null) {
      const oral = doc.categories.includes('Supplements') || /\b(tab(let)?s?|cap(sule)?s?|sachets?)\b/i.test(doc.name);
      const hit = doc.name.match(RX_NAME_RX) || String(_rxText || '').match(RX_INGREDIENT_RX) || (oral ? String(_rxText || '').match(/\btranexamic\b/i) : null);
      const topicalTxa = hit && /tranexamic/i.test(hit[0]) && !oral;
      if (hit && !topicalTxa) { doc.isRx = true; doc.rxSource = 'heuristic'; doc.rxReason = `Names a Schedule H ingredient (${hit[0].trim()})`; rx.push(`${doc.name} — ${hit[0].trim()}`); }
    }
    if (best.has(doc.slug)) doc.shopCollections = [...new Set(['bestseller', ...(doc.shopCollections || [])])];
    taxonomy.reconcile(doc);
    const invalid = new Product(doc).validateSync();
    if (invalid) problems.push(`${doc.name}: ${Object.values(invalid.errors).map((e) => e.message).join('; ')}`);
    if (!(doc.price > 0)) problems.push(`${doc.name}: no price`);
    docs.push(doc);
  }
  for (const key of ['slug', 'code', 'zenotiProductId']) {
    const seen = new Map();
    for (const d of docs) { if (!d[key]) continue; if (seen.has(d[key])) problems.push(`duplicate ${key} "${d[key]}": ${seen.get(d[key])} and ${d.name}`); seen.set(d[key], d.name); }
  }

  const tally = (get) => { const m = new Map(); for (const d of docs) for (const k of [].concat(get(d))) m.set(k, (m.get(k) || 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]); };
  console.log(`\nWILL CREATE ${docs.length} products — ${sellable ? 'ON SALE AT ONCE, no stock count' : 'counted at zero stock: listed, not sold until stock is entered'}`);
  console.log(`  categories: ${tally((d) => d.categories).map(([k, n]) => `${k} ${n}`).join(' · ')}`);
  console.log(`  concerns: ${tally((d) => d.concerns).length} in use · ${docs.filter((d) => !d.concerns.length).length} products have none`);
  console.log(`  shelves: ${tally((d) => d.shopCollections).map(([k, n]) => `${k} ${n}`).join(' · ') || 'none'}`);
  console.log(`  bestsellers (clinic sales of ${BESTSELLER_MIN_UNITS}+ units): ${docs.filter((d) => d.isPopular).map((d) => `${d.name} ×${units.get(d.slug)}`).join(' · ') || 'none'}`);
  console.log(`  prescription-only (shown, never sold in the app): ${rx.length}${rx.length ? `\n    ${rx.join('\n    ')}` : ''}`);
  console.log(`  same product as one already sold — the clinic's record carried across: ${carried.length}${carried.length ? `\n    ${carried.join('\n    ')}` : ''}`);
  console.log(`  without a photo ${docs.filter((d) => !d.image).length} · brands ${new Set(docs.map((d) => d.brand).filter(Boolean)).size}`);
  console.log(`\nWILL RETIRE ${old.length} products to products_archive (${await ArchivedProduct.countDocuments()} there now) and delete them from products`);
  console.log(`  formulations ${await Formulation.countDocuments()} → rebuilt from the new catalogue · brands ${await Brand.countDocuments()}`);
  console.log(`  shelf rows pointing at a product today: ${await Inventory.countDocuments({ productId: { $ne: null } })}`);
  console.log('  Zenoti: not contacted, nothing written.');

  if (problems.length) { console.error(`\nSTOPPED — ${problems.length} problem(s):\n  ${problems.join('\n  ')}`); await mongoose.disconnect(); process.exit(1); }
  if (!apply) { console.log('\nDRY RUN — nothing written. Re-run with --apply.'); await mongoose.disconnect(); return; }

  // 4. Backup on disk.
  const dir = path.join(__dirname, '..', 'data', 'backups', `catalogue-${stamp()}`);
  fs.mkdirSync(dir, { recursive: true });
  const links = await Inventory.find({ productId: { $ne: null } }).select('_id productId zenotiProductId code inventoryName').lean();
  fs.writeFileSync(path.join(dir, 'products.json'), JSON.stringify(old));
  fs.writeFileSync(path.join(dir, 'formulations.json'), JSON.stringify(await Formulation.find({}).lean()));
  fs.writeFileSync(path.join(dir, 'brands.json'), JSON.stringify(await Brand.find({}).lean()));
  fs.writeFileSync(path.join(dir, 'inventory-links.json'), JSON.stringify(links));
  console.log(`\nbackup written: ${dir}`);

  // 5 + 6. Retire, empty, insert, re-point — together or not at all.
  const session = await mongoose.startSession();
  let inserted = [];
  try {
    await session.withTransaction(async () => {
      const already = new Set((await ArchivedProduct.find({ _id: { $in: old.map((o) => o._id) } }).select('_id').session(session).lean()).map((r) => String(r._id)));
      const retire = old.filter((o) => !already.has(String(o._id))).map((o) => ({ ...o, archiveBatch: batch, archivedAt: new Date() }));
      if (retire.length) await ArchivedProduct.collection.insertMany(retire, { session });
      await Product.deleteMany({}, { session });
      inserted = await Product.insertMany(docs, { session, ordered: true });
      // Shelf rows: only a product carried across still has its shelves; the rest point nowhere.
      await Inventory.updateMany({ productId: { $ne: null } }, { $set: { productId: null } }, { session });
      for (const p of inserted) {
        if (!p.zenotiProductId) continue;
        await Inventory.updateMany({ zenotiProductId: p.zenotiProductId }, { $set: { productId: p._id } }, { session });
      }
      await Formulation.deleteMany({}, { session });
    });
  } finally {
    await session.endSession();
  }
  const formulations = await syncFormulationsFromProducts(Product);
  // Creates the new shop indexes; never drops one (syncIndexes would).
  await Product.createIndexes().catch((e) => console.warn(`index build: ${e.message}`));

  console.log(`\nAPPLIED: ${old.length} retired · ${inserted.length} inserted · formulations ${formulations.total}`);
  console.log(`  products now ${await Product.countDocuments()} · in the app ${await Product.countDocuments({ isAppProduct: true, isActive: true })} · archive ${await ArchivedProduct.countDocuments()}`);
  console.log(`  shelf rows attached ${await Inventory.countDocuments({ productId: { $ne: null } })}`);
  await mongoose.disconnect();
})().catch(async (e) => { console.error('FAILED — nothing was changed if this was inside the transaction:', e); await mongoose.disconnect().catch(() => {}); process.exit(1); });
