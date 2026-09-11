/**
 * Put back mirrored Zenoti appointments that the sync misread.
 *
 *   node scripts/repairZenotiStatusMisreads.js           # dry run (default) — lists what would change
 *   node scripts/repairZenotiStatusMisreads.js --commit  # apply
 *
 * Until 2026-09-11 the inbound sync read Zenoti's appointment status 4
 * ("Confirm") as "In service", so confirmed appointments — some weeks ahead —
 * were stored as In Progress, and it treated any check-in stamp, even one from
 * another day, as an arrival. The sync now reads both correctly and heals rows
 * inside its poll window by itself; this script fixes every affected row at
 * once, including appointments beyond that window.
 *
 * Scope, deliberately narrow:
 *   - source 'zenoti' rows for TODAY or later (closed history is left alone);
 *   - In Progress where Zenoti holds status 4 with no progress and no arrival,
 *     or Checked In where the only arrival is a stamp from another clinic day;
 *   - never a row someone here moved into that state (its statusLog says so).
 *
 * WRITES OUR DATABASE ONLY. It never calls Zenoti and uses raw collection
 * updates, so no Booking hook runs and nothing is pushed anywhere. Each change
 * is a compare-and-set on the current status and appends a 'system' entry to
 * the booking's statusLog, so the day book's history shows what happened.
 *
 * Run it AFTER the backend with the corrected sync is deployed — the previous
 * sync would re-apply the misread within two minutes.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const COMMIT = process.argv.includes('--commit');
const dayKey = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(d));
const when = (d) => (d ? new Date(d).toLocaleString('en-GB', {
  timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
}) : '—');
const movedHere = (b, status) => (b.statusLog || []).some((e) => e && e.to === status && e.via !== 'zenoti' && e.via !== 'system');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const bookings = mongoose.connection.db.collection('bookings');
  const now = new Date();
  const todayStart = new Date(`${dayKey(now)}T00:00:00+05:30`);
  const fields = { fullName: 1, status: 1, eventAt: 1, checkInTime: 1, statusLog: 1, preferredLocation: 1, zenotiSource: 1 };

  const inProgress = (await bookings.find({
    source: 'zenoti',
    status: 'In Progress',
    eventAt: { $gte: todayStart },
    'zenotiSource.status': { $in: [4, '4'] },
    'zenotiSource.progress': { $nin: [1, 2, '1', '2'] },
    checkInTime: null,
  }).project(fields).toArray()).filter((b) => !movedHere(b, 'In Progress'));

  const checkedIn = (await bookings.find({
    source: 'zenoti',
    status: 'Checked In',
    eventAt: { $gte: todayStart },
    checkInTime: { $ne: null },
    'zenotiSource.status': { $nin: [2, '2'] },
    'zenotiSource.progress': { $nin: [1, 2, '1', '2'] },
  }).project(fields).toArray())
    .filter((b) => dayKey(b.checkInTime) !== dayKey(b.eventAt) && !movedHere(b, 'Checked In'));

  const plan = [
    ...inProgress.map((b) => ({ b, reason: 'Zenoti status 4 is Confirm, not In service — the guest had not arrived.', unsetCheckIn: false })),
    ...checkedIn.map((b) => ({ b, reason: `Check-in stamp was from another day (${when(b.checkInTime)}), not this visit.`, unsetCheckIn: true })),
  ];

  const labelFilter = { 'zenotiSource.status': { $in: [4, '4'] }, 'zenotiSource.statusLabel': 'In service' };
  const labels = await bookings.countDocuments(labelFilter);

  console.log(`${COMMIT ? 'COMMIT' : 'DRY RUN'} — ${plan.length} appointment(s) to set back to Confirmed; ${labels} Zenoti label(s) "In service" → "Confirmed"\n`);
  for (const { b, reason } of plan) {
    console.log(`- ${when(b.eventAt)} · ${b.preferredLocation || '—'} · ${b.fullName} · ${b.status} → Confirmed · ${reason}`);
  }

  if (!COMMIT) {
    console.log('\nNothing changed. Re-run with --commit after the corrected backend is live.');
    await mongoose.disconnect();
    return;
  }

  let changed = 0;
  for (const { b, reason, unsetCheckIn } of plan) {
    const res = await bookings.updateOne(
      { _id: b._id, status: b.status }, // compare-and-set: skip if anything moved it since
      {
        $set: { status: 'Confirmed', updatedAt: now, ...(unsetCheckIn ? { checkInTime: null } : {}) },
        $push: {
          statusLog: {
            action: 'sync_correction', from: b.status, to: 'Confirmed', at: now,
            byName: 'Zenoti status correction', reason, overrode: false, via: 'system', zenoti: 'skipped', zenotiError: null,
          },
        },
      },
    );
    changed += res.modifiedCount;
  }
  const relabelled = await bookings.updateMany(labelFilter, { $set: { 'zenotiSource.statusLabel': 'Confirmed' } });
  console.log(`\nSet back to Confirmed: ${changed} of ${plan.length}. Labels corrected: ${relabelled.modifiedCount}. Zenoti was not called.`);
  await mongoose.disconnect();
})().catch(async (e) => {
  console.error('FAILED:', e.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
