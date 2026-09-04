/**
 * Link every mirrored booking to the treatment it is for.
 *
 *   node scripts/linkBookingsToServices.js
 *
 * Bookings mirrored from Zenoti store the Zenoti service id; now that the
 * catalogue is mirrored and linked, that id points at one of our treatments.
 * Database only — no Zenoti calls. Idempotent.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { buildMatcher } = require('../utils/catalogueMatch');
(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const Booking = require('../models/Booking');
  const Consultation = require('../models/Consultation');
  const rows = await Consultation.find({}).select('_id name zenotiServiceId').lean();
  const byId = new Map(rows.filter((c) => c.zenotiServiceId).map((c) => [String(c.zenotiServiceId).toLowerCase(), c._id]));
  const byName = buildMatcher(rows);
  const stats = { unlinked: 0, byId: 0, byName: 0, unmatched: 0, names: {} };
  const cursor = Booking.find({ $or: [{ consultationId: null }, { consultationId: { $exists: false } }] })
    .select('_id zenotiServiceId externalServiceName').lean().cursor();
  let ops = [];
  const flush = async () => { if (ops.length) { await Booking.bulkWrite(ops, { ordered: false }); ops = []; } };
  for await (const b of cursor) {
    stats.unlinked += 1;
    let id = b.zenotiServiceId ? byId.get(String(b.zenotiServiceId).toLowerCase()) : null;
    let how = 'byId';
    if (!id) {
      const name = b.externalServiceName;
      const hit = byName(name);
      if (hit) { id = hit._id; how = 'byName'; } else { stats.unmatched += 1; if (name) stats.names[name] = (stats.names[name] || 0) + 1; continue; }
    }
    stats[how] += 1;
    ops.push({ updateOne: { filter: { _id: b._id }, update: { $set: { consultationId: id } } } });
    if (ops.length >= 500) await flush();
  }
  await flush();
  const top = Object.entries(stats.names).sort((a, b) => b[1] - a[1]).slice(0, 15);
  delete stats.names;
  console.log(JSON.stringify(stats), '\nstill unmatched (top):', top.map(([n, c]) => `${n} (${c})`).join(' | '));
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
