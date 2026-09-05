/**
 * Re-read every mirrored booking we show as "No Show" that Zenoti does NOT
 * hold as a no-show, and make our record say what Zenoti says.
 *
 * These are the local leftovers of the 2026-09-03 auto no-show incident: the
 * job marked the rows here, and the write into Zenoti either never happened
 * or was refused because the appointment had already been deleted or moved.
 * The two-minute sync cannot heal them on its own — its merge rule keeps a
 * local No Show when Zenoti's status has not changed.
 *
 *   - Zenoti no longer has the appointment → Cancelled ("removed from the
 *     clinic diary"), the same outcome as the vanished-appointment pass.
 *   - Zenoti has it → its current status (No Show stays No Show).
 *
 * Read-only towards Zenoti; writes go through the driver so no hook can echo
 * anything back. Idempotent.
 *
 *   node scripts/repairStrandedNoShows.js            # dry run
 *   node scripts/repairStrandedNoShows.js --apply
 */

require('dotenv').config();
const mongoose = require('mongoose');
const zenoti = require('../services/zenotiService');
const { localStatus } = require('../services/zenotiAppointmentSyncService');

const APPLY = process.argv.includes('--apply');
const SLEEP_MS = Number((process.argv.find((a) => a.startsWith('--sleep-ms=')) || '').split('=')[1]) || 2000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const bookings = mongoose.connection.collection('bookings');
  const rows = await bookings.find(
    { source: 'zenoti', status: 'No Show', 'zenotiSource.status': { $nin: [-2, '-2', 'vanished'] } },
    { projection: { zenotiAppointmentId: 1, preferredDate: 1, 'zenotiSource.status': 1 } },
  ).sort({ preferredDate: -1 }).toArray();
  console.log(`${rows.length} local no-shows Zenoti never confirmed`);

  const tally = { gone: 0, noShow: 0, reverted: {}, errors: 0, written: 0 };
  for (const [i, row] of rows.entries()) {
    let detail = null; let gone = false;
    try {
      detail = await zenoti.getAppointment(row.zenotiAppointmentId);
      if (!detail) gone = true;
    } catch (error) {
      if ([404, 410].includes(error.status)) gone = true;
      else { tally.errors += 1; console.log(`  ! ${row.zenotiAppointmentId} ${error.status || ''} ${error.message}`); await sleep(SLEEP_MS * 3); continue; }
    }
    let set;
    if (gone) {
      tally.gone += 1;
      set = {
        status: 'Cancelled', cancellationReason: 'Removed from the clinic diary in Zenoti', cancelledAt: new Date(), slotHeld: false,
        'zenotiSource.status': 'vanished', 'zenotiSource.vanishedAt': new Date(), zenotiSyncStatus: 'synced', zenotiSyncError: null, zenotiLastInboundAt: new Date(),
      };
    } else {
      const next = localStatus(detail);
      if (next === 'No Show') tally.noShow += 1; else tally.reverted[next] = (tally.reverted[next] || 0) + 1;
      set = {
        status: next, 'zenotiSource.status': detail.status, 'zenotiSource.progress': detail.progress,
        zenotiSyncStatus: 'synced', zenotiSyncError: null, zenotiLastInboundAt: new Date(),
        ...(next === 'Completed' && !row.checkOutTime ? {} : {}),
      };
    }
    if (APPLY) { const r = await bookings.updateOne({ _id: row._id }, { $set: set }); tally.written += r.modifiedCount || 0; }
    if ((i + 1) % 25 === 0) console.log(`  ${i + 1}/${rows.length}`, JSON.stringify(tally));
    await sleep(SLEEP_MS);
  }
  console.log(`${APPLY ? 'APPLIED' : 'DRY RUN'}:`, JSON.stringify(tally));
  await mongoose.disconnect();
})().catch((error) => { console.error(error); process.exit(1); });
