/**
 * Rebuild the service taxonomy tree so the panel's sidebar tells the truth.
 *
 * Three things were wrong at once, and together they produced a sidebar full
 * of duplicate branches showing 0:
 *
 *  1. The Category collection still held every category that has ever existed —
 *     "Medical Treatment", "Chemical peel", "MigratedServiceCat", "Test
 *     Category". The taxonomy merge moved the SERVICES off them but left the
 *     category rows behind, so they render as empty branches.
 *  2. 749 of 812 services had no `type` (level 1: Skin / Hair / Wellness …),
 *     so the tree filed the same category under several types at once.
 *  3. `consultationCount` on each category was whatever it happened to be when
 *     it was last written.
 *
 * This sets a type on every service from its category, deletes the categories
 * nothing uses, and recounts. Categories a person deliberately created that
 * hold no services are kept — only ones that are both empty AND not part of
 * the live taxonomy are removed.
 *
 *   node scripts/rebuildServiceTree.js            # dry run
 *   node scripts/rebuildServiceTree.js --commit
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Consultation = require('../models/Consultation');
const Category = require('../models/Category');
const ServiceType = require('../models/ServiceType');

const COMMIT = process.argv.includes('--commit');

/** Level 1 for each live category. These are the app's own top-level tabs. */
const TYPE_OF = {
  'Laser Treatments': 'Skin',
  'Skin Tightening & Body Contouring': 'Skin',
  'Injectables & Fillers': 'Skin',
  'Chemical Peel': 'Skin',
  'Facial Treatments': 'Skin',
  'Skin Concerns & Minor Procedures': 'Skin',
  'Add-Ons, Masks & Miscellaneous': 'Skin',
  'Hair Treatment': 'Hair',
  'Mesotherapy & Bio-Stimulation': 'Skin & Hair',
  'IV Drips & Wellness': 'Wellness',
  'Permanent Makeup & Cosmetic Tattoo': 'Aesthetics',
  Consultation: 'Consultations',
  'Diagnostic Tests': 'Diagnostic Tests',
};

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGODB_DB || 'test' });
  console.log(COMMIT ? '*** COMMIT ***\n' : '--- DRY RUN ---\n');
  const NA = { isArchived: { $ne: true } };

  // 1. A level-1 type on every service.
  const live = (await Consultation.distinct('category', NA)).filter(Boolean);
  const unmapped = live.filter((c) => !TYPE_OF[c]);
  if (unmapped.length) console.log(`  WARNING: no type mapped for: ${unmapped.join(', ')}\n`);

  let typed = 0;
  for (const [category, type] of Object.entries(TYPE_OF)) {
    const n = await Consultation.countDocuments({ ...NA, category, $or: [{ type: { $ne: type } }, { type: null }] });
    if (!n) continue;
    typed += n;
    console.log(`  type "${type}" ← ${n} services in "${category}"`);
    if (COMMIT) await Consultation.updateMany({ ...NA, category }, { $set: { type } });
  }
  console.log(`  services retyped: ${typed}\n`);

  // 2. Categories nothing uses.
  const all = await Category.find({}).lean();
  const keep = new Set(live);
  const orphans = all.filter((c) => !keep.has(c.name));
  console.log(`  category rows: ${all.length} · live: ${keep.size} · orphaned: ${orphans.length}`);
  orphans.forEach((c) => console.log(`     remove "${c.name}"`));
  if (COMMIT && orphans.length) {
    await Category.deleteMany({ _id: { $in: orphans.map((c) => c._id) } });
  }

  // 3. Missing category rows, and correct counts on the rest.
  for (const name of live) {
    const type = TYPE_OF[name] || null;
    const count = await Consultation.countDocuments({ ...NA, category: name });
    const existing = await Category.findOne({ name });
    if (!existing) {
      console.log(`     create "${name}" (${type}) — ${count} services`);
      if (COMMIT) {
        await Category.create({
          name,
          slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
          type,
          isActive: true,
          consultationCount: count,
        });
      }
    } else if (COMMIT) {
      await Category.updateOne({ _id: existing._id }, { $set: { type, consultationCount: count, isActive: true } });
    }
  }

  // 4. The level-1 list itself.
  const types = [...new Set(Object.values(TYPE_OF))];
  for (const name of types) {
    if (!(await ServiceType.findOne({ name })) && COMMIT) {
      await ServiceType.create({ name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), isActive: true });
    }
  }

  if (COMMIT) {
    const finalCats = await Category.countDocuments();
    const stillUntyped = await Consultation.countDocuments({ ...NA, $or: [{ type: null }, { type: '' }] });
    console.log(`\nAfter: ${finalCats} categories · ${types.length} types · ${stillUntyped} services still untyped`);
  }
  await mongoose.disconnect();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
