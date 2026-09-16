/**
 * Register every formulation the catalogue already uses.
 *
 *   node scripts/backfillFormulations.js            # preview only, writes nothing
 *   node scripts/backfillFormulations.js --apply    # create the missing Formulation docs
 *
 * The Commerce catalogue was rebuilt from the OTC sheet on 2026-09-07 with a
 * formulation on every product, but the Formulation collection was never
 * seeded from it — so the product page refused every save ("Unknown
 * formulation … add it under Formulations first") on a page that no longer
 * exists. Saves now register formulations themselves; this fills in the
 * names that were already on products, and refreshes each one's product
 * count. Idempotent and safe to re-run.
 *
 * MONGODB_URI points at PRODUCTION. Run the preview first and read it.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Product = require('../models/Product');
const Formulation = require('../models/Formulation');
const { tidyName } = require('../utils/taxonomy');
const { syncFormulationsFromProducts } = require('../utils/formulations');

const APPLY = process.argv.includes('--apply');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const rows = await Product.aggregate([{ $group: { _id: '$formulation', n: { $sum: 1 } } }, { $sort: { n: -1 } }]);
  const known = new Set((await Formulation.find({}).select('name').lean()).map((f) => f.name));
  console.log(`Formulation docs today: ${known.size}`);
  const blank = rows.filter((r) => !tidyName(r._id)).reduce((n, r) => n + r.n, 0);
  for (const r of rows) {
    const name = tidyName(r._id);
    if (!name) continue;
    console.log(`  ${known.has(name) ? 'ok     ' : 'missing'}  ${name}  (${r.n} product${r.n === 1 ? '' : 's'})`);
  }
  if (blank) console.log(`  ${blank} product(s) have no formulation — they get one the next time they are saved from the product page.`);
  if (!APPLY) { console.log('\nPreview only. Re-run with --apply to register the missing ones.'); return; }
  const { created, total } = await syncFormulationsFromProducts(Product);
  console.log(`\nRegistered ${created.length}: ${created.join(', ') || '—'}\nFormulation docs now: ${total}`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => mongoose.disconnect());
