/**
 * Merge near-duplicate service categories and sub-categories.
 *
 * Zenoti's own master data carries "Chemical Peel" and "Chemical Peels",
 * "Medical Treatment" and "Medical Treatments", side by side. Imported
 * verbatim they become two filters for one thing in the panel and two
 * sections in the app. The importer now WARNS about this before a commit;
 * this repairs what is already there.
 *
 * The survivor is the spelling with the most services behind it — the
 * clinic's de-facto choice, not ours.
 *
 *   node scripts/mergeServiceTaxonomy.js            # dry run
 *   node scripts/mergeServiceTaxonomy.js --commit
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Consultation = require('../models/Consultation');

const COMMIT = process.argv.includes('--commit');
const stem = (v) => String(v).toLowerCase().replace(/[^a-z0-9]/g, '').replace(/s$/, '');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGODB_DB || 'test' });
  console.log(COMMIT ? '*** COMMIT ***' : '--- DRY RUN ---');

  for (const field of ['category', 'subCategory']) {
    const values = (await Consultation.distinct(field, { isArchived: { $ne: true } })).filter(Boolean);
    const groups = new Map();
    values.forEach((v) => groups.set(stem(v), [...(groups.get(stem(v)) || []), v]));

    for (const variants of [...groups.values()].filter((a) => a.length > 1)) {
      const counted = await Promise.all(variants.map(async (v) => ({
        v, n: await Consultation.countDocuments({ [field]: v, isArchived: { $ne: true } }),
      })));
      counted.sort((a, b) => b.n - a.n);
      const [winner, ...losers] = counted;
      for (const l of losers) {
        console.log(`  ${field}: "${l.v}" (${l.n}) → "${winner.v}" (${winner.n})`);
        if (COMMIT) await Consultation.updateMany({ [field]: l.v }, { $set: { [field]: winner.v } });
      }
    }
  }

  const cats = (await Consultation.distinct('category', { isArchived: { $ne: true } })).filter(Boolean);
  const subs = (await Consultation.distinct('subCategory', { isArchived: { $ne: true } })).filter(Boolean);
  console.log(`\nNow: ${cats.length} categories · ${subs.length} sub-categories`);
  await mongoose.disconnect();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
