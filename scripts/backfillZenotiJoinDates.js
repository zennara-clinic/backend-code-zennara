/**
 * Give every imported clinic patient their real join date.
 *
 * The roster import stamped `User.createdAt` with the import run (2026-08-23),
 * so the panel's "Joined" column showed the same day for ~6,900 patients.
 * Zenoti's `guest.created_date` is already mirrored in
 * `ZenotiGuestData.profile.createdDate`, so this needs no API calls.
 *
 * Rule: `zenotiCreatedAt` = Zenoti's registration instant; `createdAt` becomes
 * the EARLIER of the two (an app sign-up that predates the clinic record keeps
 * its own date). Idempotent.
 *
 *   node scripts/backfillZenotiJoinDates.js            # dry run
 *   node scripts/backfillZenotiJoinDates.js --apply    # write
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { clinicInstant } = require('../config/zenoti');

const APPLY = process.argv.includes('--apply');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const GuestData = require('../models/ZenotiGuestData');
  const users = mongoose.connection.collection('users');

  const cursor = GuestData.find({ 'profile.createdDate': { $nin: [null, ''] } })
    .select('userId profile.createdDate').lean().cursor();

  const tally = { seen: 0, parsed: 0, wouldMoveCreatedAt: 0, written: 0, unparseable: 0 };
  let ops = [];
  const flush = async () => {
    if (!ops.length) return;
    if (APPLY) {
      const res = await users.bulkWrite(ops, { ordered: false });
      tally.written += res.modifiedCount || 0;
    }
    ops = [];
  };

  const existing = new Map(
    (await users.find({ source: 'zenoti' }, { projection: { createdAt: 1 } }).toArray())
      .map((u) => [String(u._id), u.createdAt]),
  );

  for await (const row of cursor) {
    tally.seen += 1;
    const at = clinicInstant(row.profile.createdDate);
    if (!at) { tally.unparseable += 1; continue; }
    tally.parsed += 1;
    const current = existing.get(String(row.userId));
    if (!current || at < current) tally.wouldMoveCreatedAt += 1;
    ops.push({
      updateOne: {
        filter: { _id: row.userId },
        // $min only moves createdAt backwards; $set records Zenoti's own date.
        update: { $set: { zenotiCreatedAt: at }, $min: { createdAt: at } },
      },
    });
    if (ops.length >= 500) await flush();
  }
  await flush();

  console.log(`${APPLY ? 'APPLIED' : 'DRY RUN'}:`, tally);
  if (!APPLY) console.log('Re-run with --apply to write.');
  await mongoose.disconnect();
})().catch((error) => { console.error(error); process.exit(1); });
