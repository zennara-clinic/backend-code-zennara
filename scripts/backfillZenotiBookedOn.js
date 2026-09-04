/**
 * Give every mirrored Zenoti appointment its real "Booked on" date.
 *
 * Bookings first mirrored from the per-guest history feed carry the crawl day
 * as `createdAt` (23–25 Aug / 2 Sep 2026) because that feed has no
 * creation_date. The CENTRE DIARY does (creation_date_utc, created_by_name),
 * but only in windows of ≤10 days, so this walks each clinic's diary from its
 * earliest mirrored visit to +10 days and corrects `createdAt` through the
 * driver (the field is immutable through Mongoose). Read-only towards Zenoti.
 *
 * Roughly 230 requests for the whole history; each call is spaced so the
 * production syncs keep most of the shared 50/min budget. Idempotent.
 *
 *   node scripts/backfillZenotiBookedOn.js                    # dry run
 *   node scripts/backfillZenotiBookedOn.js --apply
 *   node scripts/backfillZenotiBookedOn.js --apply --center ZENJH --from 2026-01-01
 */

require('dotenv').config();
const mongoose = require('mongoose');
const zenoti = require('../services/zenotiService');
const { CENTERS, clinicInstant } = require('../config/zenoti');

const APPLY = process.argv.includes('--apply');
const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; };
const ONLY_CENTER = arg('--center');
const FROM_ARG = arg('--from');
const SLEEP_MS = Number(arg('--sleep-ms')) || 1500;
const WINDOW_DAYS = 9; // getCenterAppointments adds the exclusive end day → 10-day request

const day = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const bookings = mongoose.connection.collection('bookings');
  const clinics = Object.entries(CENTERS).filter(([, c]) => c.isClinic && (!ONLY_CENTER || c.code === ONLY_CENTER));
  const horizon = addDays(new Date(), 10);
  const total = { requests: 0, rows: 0, matched: 0, changed: 0, written: 0, failedWindows: 0 };

  for (const [centerId, centre] of clinics) {
    const earliest = FROM_ARG
      ? new Date(`${FROM_ARG}T00:00:00Z`)
      : (await bookings.find({ source: 'zenoti', preferredLocation: centre.branchName }).sort({ preferredDate: 1 }).limit(1).project({ preferredDate: 1 }).next())?.preferredDate;
    if (!earliest) { console.log(`${centre.name}: no mirrored bookings, skipped`); continue; }
    console.log(`\n${centre.name}: ${day(earliest)} → ${day(horizon)}`);

    for (let from = new Date(earliest); from <= horizon; from = addDays(from, WINDOW_DAYS + 1)) {
      const to = addDays(from, WINDOW_DAYS);
      let rows;
      try {
        rows = await zenoti.getCenterAppointments(centerId, { from: day(from), to: day(to), includeCancelled: true });
      } catch (error) {
        total.failedWindows += 1;
        console.log(`  ${day(from)}→${day(to)} FAILED: ${error.message}`);
        await sleep(SLEEP_MS * 4);
        continue;
      }
      total.requests += 1;
      total.rows += rows.length;

      const ids = rows.map((r) => r.id).filter(Boolean);
      const local = ids.length
        ? await bookings.find({ zenotiAppointmentId: { $in: ids } }).project({ zenotiAppointmentId: 1, createdAt: 1 }).toArray()
        : [];
      const byId = new Map(local.map((b) => [String(b.zenotiAppointmentId).toLowerCase(), b]));

      const ops = [];
      for (const row of rows) {
        const b = byId.get(String(row.id).toLowerCase());
        if (!b) continue;
        total.matched += 1;
        const bookedAt = clinicInstant(row.createdAtUtc ? `${row.createdAtUtc}Z` : row.createdAt);
        if (!bookedAt) continue;
        const set = { 'zenotiSource.createdAt': bookedAt };
        if (row.createdByName) set['zenotiSource.createdByName'] = row.createdByName;
        if (Math.abs((b.createdAt?.getTime() || 0) - bookedAt.getTime()) > 60_000) { set.createdAt = bookedAt; total.changed += 1; }
        ops.push({ updateOne: { filter: { _id: b._id }, update: { $set: set } } });
      }
      if (APPLY && ops.length) {
        const res = await bookings.bulkWrite(ops, { ordered: false });
        total.written += res.modifiedCount || 0;
      }
      console.log(`  ${day(from)}→${day(to)} diary ${String(rows.length).padStart(4)}  ours ${String(ops.length).padStart(4)}`);
      await sleep(SLEEP_MS);
    }
  }

  console.log(`\n${APPLY ? 'APPLIED' : 'DRY RUN'}:`, total);
  if (!APPLY) console.log('Re-run with --apply to write.');
  await mongoose.disconnect();
})().catch((error) => { console.error(error); process.exit(1); });
