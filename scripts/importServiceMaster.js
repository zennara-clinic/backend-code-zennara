/**
 * Import Zenoti's service master into Consultation.
 *
 * Usage:
 *   node scripts/importServiceMaster.js --file "<path to xlsx/csv>" [--commit]
 *
 * Without --commit it reports what WOULD happen and writes nothing.
 *
 * The clinic's export is the master list of everything it bills for. It is not
 * a customer menu: it contains staff lines, per-doctor variants and one-off
 * billing entries. Imported rows are therefore master data with
 * `inCatalog: false`; the desk publishes the ones a customer should see.
 *
 * Rows already here that the file does NOT mention are ARCHIVED, never deleted:
 * 36,000+ bookings and 2,400 package sales reference services by id, and
 * deleting a row would strand every one of them. An archived service is hidden
 * from the panel list and the app, but every historical reference still
 * resolves to a named treatment.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const Consultation = require('../models/Consultation');
const { readWorkbook } = require('../utils/bulkCsv');
const { ENTITIES } = require('../controllers/bulkController');

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? (process.argv[i + 1] ?? true) : fallback;
};
const COMMIT = process.argv.includes('--commit');

(async () => {
  const file = arg('file');
  if (!file || !fs.existsSync(file)) {
    console.error('Pass --file "<path to the Zenoti services export>"');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGODB_DB || 'test' });

  const entity = ENTITIES.services;
  const { headers, records } = readWorkbook(
    { originalname: path.basename(file), buffer: fs.readFileSync(file) },
    entity.columns,
  );
  const missing = entity.required.filter((c) => !headers.includes(c));
  if (missing.length) {
    console.error(`File is missing column(s): ${missing.join(', ')}`);
    process.exit(1);
  }

  console.log(`Read ${records.length} rows from ${path.basename(file)}`);
  console.log(COMMIT ? '*** COMMIT MODE — this will write ***' : '--- DRY RUN — nothing will be written ---\n');

  /*
   * What the app shows RIGHT NOW.
   *
   * Everything imports as master data (inCatalog:false). Without this the
   * import would empty the app's treatment list the moment it ran. The rows the
   * customer can already see are re-published automatically, so the storefront
   * is unchanged by the import and the catalogue tab becomes a tool for adding
   * MORE — never a cliff.
   */
  const liveBefore = new Set(
    (await Consultation.find({
      isArchived: { $ne: true },
      $or: [{ inCatalog: true }, { isActive: true, inCatalog: { $exists: false } }],
    }).select('_id').lean()).map((d) => String(d._id)),
  );
  console.log(`  ${liveBefore.size} services are visible in the app today — they stay visible.\n`);

  const seen = new Set();
  const touched = new Set();
  let created = 0; let updated = 0; let skipped = 0; let dupes = 0;
  const errors = [];

  for (const { row, data } of records) {
    const problems = entity.validate(data);
    if (problems.length) { errors.push({ row, problems, name: data.ServiceName }); skipped += 1; continue; }
    const key = entity.keyOf(data);
    if (!key) { skipped += 1; continue; }
    if (seen.has(key)) { dupes += 1; continue; }
    seen.add(key);

    const existing = await entity.find(key, data);
    if (existing) {
      entity.apply(existing, data, { creating: false });
      if (COMMIT) await existing.save();
      touched.add(String(existing._id));
      updated += 1;
    } else {
      const doc = new Consultation({});
      const prepared = entity.prepare ? await entity.prepare(data) : null;
      entity.apply(doc, data, { creating: true, prepared });
      if (COMMIT) { await doc.save(); touched.add(String(doc._id)); }
      created += 1;
    }
  }

  /*
   * Anything live that the file did not mention is superseded — EXCEPT what the
   * app is currently showing.
   *
   * Learned the hard way: Zenoti's export uses operational billing names
   * ("Laser Toning LIPS Dr Rickson", "5 body parts 1 sess - LHR") while the app
   * menu uses customer-facing ones ("Laser Hair Removal (LHR)"). Only 13 of 63
   * matched, so a plain "archive everything not in the file" collapsed the
   * storefront from 63 treatments to 11. A published service is never archived
   * by an import; it is the desk's deliberate choice, and only the desk unpublishes it.
   */
  const staleFilter = COMMIT
    ? {
      isArchived: { $ne: true },
      inCatalog: { $ne: true },
      _id: { $nin: [...touched].map((id) => new mongoose.Types.ObjectId(id)) },
    }
    : { isArchived: { $ne: true }, inCatalog: { $ne: true } };
  const stale = await Consultation.countDocuments(staleFilter);

  console.log(`  created : ${created}`);
  console.log(`  updated : ${updated}`);
  console.log(`  in-file duplicates skipped : ${dupes}`);
  console.log(`  invalid rows skipped       : ${skipped}`);
  errors.slice(0, 5).forEach((e) => console.log(`     row ${e.row} "${e.name || ''}": ${e.problems.join('; ')}`));
  console.log(`  to archive (not in the file): ${COMMIT ? stale : `${stale} live rows — exact count known only after a commit`}`);

  if (COMMIT) {
    const res = await Consultation.updateMany(staleFilter, {
      $set: {
        isArchived: true,
        archivedAt: new Date(),
        archivedReason: `Superseded by service master import ${new Date().toISOString().slice(0, 10)}`,
        inCatalog: false,
      },
    });
    console.log(`  archived: ${res.modifiedCount}`);

    // Re-publish whatever the customer could already see.
    // Everything the customer could see stays visible, whether or not the new
    // file happened to name it.
    const keep = [...liveBefore].map((id) => new mongoose.Types.ObjectId(id));
    const pub = await Consultation.updateMany(
      { _id: { $in: keep }, isArchived: { $ne: true } },
      { $set: { inCatalog: true, catalogAddedAt: new Date(), catalogAddedBy: 'Service master import' } },
    );
    console.log(`  re-published to the app catalogue: ${pub.modifiedCount} of ${liveBefore.size}`);
    const unmatched = [...liveBefore].filter((id) => !touched.has(id));
    if (unmatched.length) {
      const names = await Consultation.find({ _id: { $in: unmatched.map((i) => new mongoose.Types.ObjectId(i)) } }).select('name').lean();
      console.log(`  published but NOT named in this file — kept visible, still need a Zenoti match (${unmatched.length}):`);
      names.slice(0, 30).forEach((n) => console.log(`     · ${n.name}`));
    }
  }

  const live = await Consultation.countDocuments({ isArchived: { $ne: true } });
  const cat = await Consultation.countDocuments({ isArchived: { $ne: true }, inCatalog: true });
  console.log(`\nAfter this run: ${live} live services · ${cat} published to the app catalogue`);
  await mongoose.disconnect();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
