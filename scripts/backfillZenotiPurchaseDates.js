/**
 * Date mirrored clinic purchases on the day they were bought.
 *
 * Package assignments and counter-sale orders mirrored from Zenoti carried the
 * mirror run as `createdAt` (2026-09-04) because Mongoose keeps createdAt
 * immutable and silently dropped the intended correction. The real instants
 * are already local: `payment.receivedDate` / `validFrom` on the assignment,
 * and `saleDate` on the matching line in `ZenotiGuestData.orders`. No API
 * calls. Idempotent.
 *
 *   node scripts/backfillZenotiPurchaseDates.js            # dry run
 *   node scripts/backfillZenotiPurchaseDates.js --apply
 */

require('dotenv').config();
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');
const differs = (a, b) => Math.abs((a?.getTime?.() || 0) - b.getTime()) > 60_000;

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const assignments = mongoose.connection.collection('packageassignments');
  const orders = mongoose.connection.collection('productorders');
  const guestData = mongoose.connection.collection('zenotiguestdatas');
  const tally = { assignments: { seen: 0, change: 0, written: 0 }, orders: { seen: 0, matched: 0, change: 0, written: 0 } };

  // Assignments: the purchase instant is on the row itself.
  let ops = [];
  for await (const a of assignments.find({ source: 'zenoti' }, { projection: { createdAt: 1, 'payment.receivedDate': 1, validFrom: 1 } })) {
    tally.assignments.seen += 1;
    const at = a.payment?.receivedDate || a.validFrom;
    if (!at || !differs(a.createdAt, new Date(at))) continue;
    tally.assignments.change += 1;
    ops.push({ updateOne: { filter: { _id: a._id }, update: { $set: { createdAt: new Date(at) } } } });
  }
  if (APPLY && ops.length) tally.assignments.written = (await assignments.bulkWrite(ops, { ordered: false })).modifiedCount || 0;

  // Orders: the sale date lives on the mirrored guest history line.
  const saleDateById = new Map();
  for await (const g of guestData.find({ 'orders.0': { $exists: true } }, { projection: { orders: 1 } })) {
    for (const line of g.orders || []) if (line?.id && line.saleDate) saleDateById.set(String(line.id).toLowerCase(), line.saleDate);
  }
  ops = [];
  for await (const o of orders.find({ source: 'zenoti' }, { projection: { createdAt: 1, zenotiSaleId: 1 } })) {
    tally.orders.seen += 1;
    const raw = saleDateById.get(String(o.zenotiSaleId || '').toLowerCase());
    if (!raw) continue;
    tally.orders.matched += 1;
    const at = new Date(raw);
    if (Number.isNaN(at.getTime()) || !differs(o.createdAt, at)) continue;
    tally.orders.change += 1;
    ops.push({ updateOne: { filter: { _id: o._id }, update: { $set: { createdAt: at } } } });
  }
  if (APPLY && ops.length) tally.orders.written = (await orders.bulkWrite(ops, { ordered: false })).modifiedCount || 0;

  console.log(`${APPLY ? 'APPLIED' : 'DRY RUN'}:`, JSON.stringify(tally));
  if (!APPLY) console.log('Re-run with --apply to write.');
  await mongoose.disconnect();
})().catch((error) => { console.error(error); process.exit(1); });
