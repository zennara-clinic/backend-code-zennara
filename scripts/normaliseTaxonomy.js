/**
 * Merge duplicated category / sub-category / formulation spellings in the catalogue.
 *   node --env-file=.env scripts/normaliseTaxonomy.js [--apply]
 * "Skin Care"+"Skincare" → the more common spelling; "Anti- Aging" → "Anti-Aging";
 * "None"/"None." → blank. Names are otherwise kept exactly as the sheet wrote them.
 */
require('dotenv').config();
const mongoose = require('mongoose');
(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const Product = require('../models/Product');
  const { loadCanon, snapProduct } = require('../utils/taxonomy');
  const apply = process.argv.includes('--apply');
  const canon = await loadCanon(Product);
  const rows = await Product.find({}).select('name productCategory productSubCategory formulation').lean();
  const plan = []; const merges = new Map();
  for (const p of rows) {
    const before = { productCategory: p.productCategory, productSubCategory: p.productSubCategory, formulation: p.formulation };
    const doc = { ...before }; const changed = snapProduct(doc, canon);
    if (!changed.length) continue;
    plan.push({ _id: p._id, name: p.name, set: doc });
    for (const f of changed) merges.set(`${f}: ${JSON.stringify(before[f])} → ${JSON.stringify(doc[f])}`, (merges.get(`${f}: ${JSON.stringify(before[f])} → ${JSON.stringify(doc[f])}`) || 0) + 1);
  }
  console.log(`products touched: ${plan.length} of ${rows.length}`);
  for (const [k, n] of [...merges.entries()].sort()) console.log(`  ${k}  ×${n}`);
  if (!apply) { console.log('\nDRY RUN — re-run with --apply'); await mongoose.disconnect(); return; }
  if (plan.length) await Product.bulkWrite(plan.map((p) => ({ updateOne: { filter: { _id: p._id }, update: { $set: p.set } } })));
  const after = await loadCanon(Product);
  console.log(`\nAPPLIED. distinct now — categories ${after.productCategory.size} · sub-categories ${after.productSubCategory.size} · formulations ${after.formulation.size}`);
  await mongoose.disconnect();
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
