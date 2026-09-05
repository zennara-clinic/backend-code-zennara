/**
 * Pull in every appointment the Zenoti centre diary holds that has no local
 * Booking yet.
 *
 * The per-guest history feed — which the roster import and the 5-minute crawl
 * mirror from — does not return no-shows or cancellations, and the 2-minute
 * reconciler only reads a near window. So historical no-shows and cancelled
 * visits (about 13% of the diary) never reached the panel, the no-show tabs or
 * the analytics. This walks each clinic's diary in Zenoti's maximum 10-day
 * windows and upserts only the rows that are missing here. It never retires
 * anything (the guest feed holds migrated visits the diary no longer has) and
 * never writes to Zenoti.
 *
 *   node scripts/backfillDiaryVisits.js                       # dry run: counts only
 *   node scripts/backfillDiaryVisits.js --apply
 *   node scripts/backfillDiaryVisits.js --apply --center ZENJH --from 2025-01-01
 */

require('dotenv').config();
const mongoose = require('mongoose');
const zenoti = require('../services/zenotiService');
const { CENTERS } = require('../config/zenoti');

const APPLY = process.argv.includes('--apply');
const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; };
const ONLY_CENTER = arg('--center');
const FROM_ARG = arg('--from');
const SLEEP_MS = Number(arg('--sleep-ms')) || 2000;
const WINDOW_DAYS = 9;

const day = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const Booking = require('../models/Booking');
  const User = require('../models/User');
  const sync = require('../services/zenotiAppointmentSyncService');
  const { provisionUserFromGuest } = require('../services/zenotiSyncService');

  const clinics = Object.entries(CENTERS).filter(([, c]) => (ONLY_CENTER ? c.code === ONLY_CENTER : c.isClinic));
  const lastVisit = (await Booking.findOne({ source: 'zenoti' }).sort({ preferredDate: -1 }).select('preferredDate').lean())?.preferredDate;
  const horizon = addDays(lastVisit && lastVisit > new Date() ? lastVisit : new Date(), 10);
  const total = { requests: 0, diary: 0, missing: 0, created: 0, updated: 0, skipped: 0, failed: 0, byStatus: {}, failedWindows: 0 };

  const context = await sync.lookupContext();
  const linked = await User.find({ zenotiGuestId: { $exists: true, $ne: null } }).select('_id fullName phone email zenotiGuestId zenotiCenterId source').lean();
  const userByGuest = new Map(linked.map((u) => [String(u.zenotiGuestId).toLowerCase(), u]));

  for (const [centerId, centre] of clinics) {
    const earliest = FROM_ARG
      ? new Date(`${FROM_ARG}T00:00:00Z`)
      : (await Booking.findOne({ source: 'zenoti', 'zenotiSource.centerId': centerId }).sort({ preferredDate: 1 }).select('preferredDate').lean())?.preferredDate;
    if (!earliest) { console.log(`${centre.name}: nothing mirrored, skipped`); continue; }
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
      total.diary += rows.length;

      const ids = rows.map((r) => r.id).filter(Boolean);
      const have = new Set((await Booking.find({ zenotiAppointmentId: { $in: ids } }).select('zenotiAppointmentId').lean()).map((b) => String(b.zenotiAppointmentId).toLowerCase()));
      const missing = rows.filter((r) => r.id && !have.has(String(r.id).toLowerCase()));
      total.missing += missing.length;
      missing.forEach((r) => { const k = String(r.status); total.byStatus[k] = (total.byStatus[k] || 0) + 1; });

      let created = 0;
      if (APPLY) {
        for (const appointment of missing) {
          try {
            const guestId = String(appointment.guest?.zenotiGuestId || '').toLowerCase();
            let owner = userByGuest.get(guestId) || null;
            if (!owner && appointment.guest) {
              owner = await provisionUserFromGuest(appointment.guest, { quiet: true });
              if (owner?.zenotiGuestId) userByGuest.set(String(owner.zenotiGuestId).toLowerCase(), owner);
            }
            const result = await sync.upsertAppointment(appointment, { user: owner, context });
            total[result.outcome] = (total[result.outcome] || 0) + 1;
            if (result.outcome === 'created') created += 1;
          } catch (error) {
            total.failed += 1;
            console.log(`  ! ${appointment.id} ${error.message}`);
          }
        }
      }
      console.log(`  ${day(from)}→${day(to)} diary ${String(rows.length).padStart(4)}  missing ${String(missing.length).padStart(3)}${APPLY ? `  created ${created}` : ''}`);
      await sleep(SLEEP_MS);
    }
  }

  console.log(`\n${APPLY ? 'APPLIED' : 'DRY RUN'}:`, JSON.stringify(total));
  if (!APPLY) console.log('Re-run with --apply to write.');
  await mongoose.disconnect();
})().catch((error) => { console.error(error); process.exit(1); });
