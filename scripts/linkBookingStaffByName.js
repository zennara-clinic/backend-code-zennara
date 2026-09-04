/**
 * Link bookings whose Zenoti row named the staff member but carried no id.
 *
 *   node scripts/linkBookingStaffByName.js          (preview)
 *   node scripts/linkBookingStaffByName.js --apply
 *
 * Older Zenoti appointments come with "Dr.Spoorthy" and no employee id. The
 * name is matched (title dropped, spacing ignored) against the mirrored
 * dermatologists and therapists; a unique hit stamps the booking with that
 * person's Zenoti employee id, which is how every screen resolves the staff
 * member. Database only, idempotent.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { normalizeName } = require('../utils/nameMatch');
const APPLY = process.argv.includes('--apply');
const key = (v) => normalizeName(String(v || '').replace(/\bdr\.?\s*/gi, ' ')).split(' ').filter(Boolean);
(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const Booking = require('../models/Booking');
  const Doctor = require('../models/Doctor');
  const ZenotiPractitioner = require('../models/ZenotiPractitioner');
  const staff = [
    ...(await Doctor.find({ zenotiEmployeeId: { $nin: [null, ''] } }).select('name zenotiEmployeeId').lean()).map((d) => ({ name: d.name, id: String(d.zenotiEmployeeId).toLowerCase() })),
    ...(await ZenotiPractitioner.find({}).select('name zenotiEmployeeId').lean()).map((p) => ({ name: p.name, id: String(p.zenotiEmployeeId).toLowerCase() })),
  ];
  const seen = new Set();
  const pool = staff.filter((s) => s.id && !seen.has(s.id) && seen.add(s.id)).map((s) => ({ ...s, tokens: key(s.name) }));
  const resolve = (name) => {
    const want = key(name);
    if (!want.length) return null;
    let hits = pool.filter((s) => s.tokens.join(' ') === want.join(' '));
    if (!hits.length) hits = pool.filter((s) => s.tokens.join('') === want.join(''));
    if (!hits.length) hits = pool.filter((s) => want.every((w) => s.tokens.includes(w)));   // "Spoorthy" ⊂ "Spoorthy Reddy"
    if (!hits.length) hits = pool.filter((s) => s.tokens.every((w) => want.includes(w)));   // "Rickson Pereira" ⊂ "Dr Rickson Pereira Skin"
    if (hits.length !== 1) return null;
    // "Swetha A" names a surname initial; it must agree with the record's surname.
    const initial = (String(name).trim().match(/\s([A-Za-z])\.?$/) || [])[1]?.toLowerCase() || null; // from the raw name: "a" is a stop-word
    if (initial) {
      const surname = hits[0].tokens.filter((w) => !want.slice(0, -1).includes(w));
      if (!surname.some((w) => w.startsWith(initial))) return null;
    }
    return hits[0];
  };
  const names = await Booking.aggregate([
    { $match: { $or: [{ zenotiTherapistId: null }, { zenotiTherapistId: '' }], therapistName: { $nin: [null, ''] } } },
    { $group: { _id: '$therapistName', n: { $sum: 1 } } }, { $sort: { n: -1 } },
  ]);
  const out = { names: names.length, bookings: 0, linked: 0, samples: [], left: [] };
  for (const r of names) {
    out.bookings += r.n;
    const hit = resolve(r._id);
    if (!hit) { out.left.push(`${r._id} (${r.n})`); continue; }
    out.linked += r.n;
    if (out.samples.length < 12) out.samples.push(`${r._id} → ${hit.name} (${r.n})`);
    if (APPLY) await Booking.updateMany({ therapistName: r._id, $or: [{ zenotiTherapistId: null }, { zenotiTherapistId: '' }] }, { $set: { zenotiTherapistId: hit.id, zenotiTherapistName: hit.name } });
  }
  console.log(APPLY ? 'APPLIED' : 'PREVIEW', JSON.stringify({ names: out.names, bookings: out.bookings, linked: out.linked }));
  console.log('  e.g.\n  ' + out.samples.join('\n  '));
  console.log('  left:', out.left.slice(0, 20).join(' | '));
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
