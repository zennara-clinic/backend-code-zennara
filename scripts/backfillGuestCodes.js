/*
 * Backfill User.guestCode from Zenoti's guest code.
 *
 * The guest's printed identity used to be a locally generated `patientId`
 * ("ZENUPPZ0"). The clinic prints Zenoti's own guest code ("ZENFD637") on
 * paper and quotes it at the desk, so that is the one we show. We already hold
 * it for almost every guest: the mirror stores the full Zenoti profile in
 * `zenotiguestdatas.profile.code`, refreshed on every detail sync — so this
 * backfill needs no Zenoti API calls and costs nothing against the shared rate
 * budget.
 *
 * Guests Zenoti has no code for keep their local `patientId`; this script
 * never touches `patientId` and never blanks a code it cannot improve.
 *
 * Dry run (default — reports, changes nothing):
 *     node scripts/backfillGuestCodes.js
 * Apply:
 *     node scripts/backfillGuestCodes.js --commit
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

const COMMIT = process.argv.includes('--commit');

const norm = (v) => String(v ?? '').trim();

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const mirror = mongoose.connection.db.collection('zenotiguestdatas');

  // Zenoti guest id → code. GUID casing has drifted across historical imports,
  // so key everything lowercase (GUID identity is case-insensitive).
  const codeByGuest = new Map();
  const cursor = mirror.find(
    { 'profile.code': { $nin: [null, ''] } },
    { projection: { zenotiGuestId: 1, 'profile.code': 1 } },
  );
  for await (const row of cursor) {
    const code = norm(row?.profile?.code);
    if (code) codeByGuest.set(norm(row.zenotiGuestId).toLowerCase(), code);
  }

  const users = await User.find({ zenotiGuestId: { $nin: [null, ''] } })
    .select('guestCode patientId zenotiGuestId fullName')
    .lean();

  const stats = { mirrored: codeByGuest.size, linkedUsers: users.length, toSet: 0, unchanged: 0, wouldChange: 0, noCode: 0 };
  const holders = new Map(); // code → [user], to catch two accounts sharing one code
  const plan = [];
  const changes = [];

  for (const u of users) {
    const code = codeByGuest.get(norm(u.zenotiGuestId).toLowerCase());
    if (!code) { stats.noCode += 1; continue; }
    holders.set(code, [...(holders.get(code) || []), u]);
    if (norm(u.guestCode) === code) { stats.unchanged += 1; continue; }
    if (u.guestCode) {
      // Zenoti changed a code we had already mirrored. Zenoti is the master,
      // so we follow it — but it is worth seeing, because anything already
      // printed on paper still carries the old one.
      stats.wouldChange += 1;
      changes.push({ user: u.fullName, from: u.guestCode, to: code });
    }
    stats.toSet += 1;
    plan.push({ _id: u._id, code });
  }

  const duplicates = [...holders.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([code, list]) => ({ code, users: list.map((u) => `${u.fullName} (${u._id})`) }));

  const unlinked = await User.countDocuments({ $or: [{ zenotiGuestId: null }, { zenotiGuestId: '' }, { zenotiGuestId: { $exists: false } }] });

  console.log(JSON.stringify({
    mode: COMMIT ? 'COMMIT' : 'dry run',
    ...stats,
    unlinkedUsers: unlinked,
    keepingLocalId: stats.noCode + unlinked,
    duplicateCodes: duplicates.length,
    duplicates: duplicates.slice(0, 20),
    codeChanges: changes.slice(0, 20),
  }, null, 2));

  if (!COMMIT) {
    console.log('\nDry run — nothing written. Re-run with --commit to apply.');
    await mongoose.disconnect();
    return;
  }

  let written = 0;
  for (let i = 0; i < plan.length; i += 500) {
    const batch = plan.slice(i, i + 500);
    const res = await User.bulkWrite(
      batch.map(({ _id, code }) => ({ updateOne: { filter: { _id }, update: { $set: { guestCode: code } } } })),
      { ordered: false },
    );
    written += res.modifiedCount || 0;
  }
  console.log(`\nWrote guestCode for ${written} guests. patientId untouched.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('backfillGuestCodes failed:', err.message);
  process.exit(1);
});
