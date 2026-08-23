/**
 * Import every Zenoti guest and every supported per-guest dataset.
 *
 *   node scripts/zenotiImportRoster.js               # full import
 *   node scripts/zenotiImportRoster.js --roster-only # emergency roster-only run
 *
 * Safe to re-run: guests are matched by Zenoti id, then phone/email.
 */
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const importer = require('../services/zenotiImportService');
  const args = process.argv.slice(2);

  const t0 = Date.now();
  const tally = args.includes('--roster-only')
    ? await importer.importRoster({ trigger: 'manual' })
    : await importer.fullImport({ trigger: 'manual' });
  console.log(args.includes('--roster-only') ? 'Roster:' : 'Full import:', tally, `${Math.round((Date.now() - t0) / 1000)}s`);
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
