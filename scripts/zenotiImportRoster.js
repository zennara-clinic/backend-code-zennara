/**
 * Mirror every Zenoti guest into a local User (source: 'zenoti'), then
 * optionally start the per-guest history crawl.
 *
 *   node scripts/zenotiImportRoster.js            # full roster
 *   node scripts/zenotiImportRoster.js --crawl 40 # roster + sync 40 stalest guests' history
 *
 * Safe to re-run: guests are matched by Zenoti id, then phone/email.
 */
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const importer = require('../services/zenotiImportService');
  const args = process.argv.slice(2);
  const crawlIdx = args.indexOf('--crawl');

  const t0 = Date.now();
  const tally = await importer.importRoster({ trigger: 'manual' });
  console.log('Roster:', tally, `${Math.round((Date.now() - t0) / 1000)}s`);

  if (crawlIdx !== -1) {
    const limit = parseInt(args[crawlIdx + 1], 10) || 40;
    const c = await importer.crawlDetails({ limit, trigger: 'manual' });
    console.log('History crawl:', c);
  }
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
