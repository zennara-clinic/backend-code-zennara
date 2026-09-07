/**
 * Can every service the app shows actually be booked in Zenoti?
 *
 * A mapping that points at a service id proves nothing on its own: the id can
 * be stale, the service can be inactive, it can be flagged not-bookable, or it
 * can exist at one clinic and not the two others. Any of those and the booking
 * push fails at the moment a real guest is waiting for a confirmation.
 *
 * So this checks the mapping against Zenoti's live catalogue, per centre, and
 * reports what a guest would actually experience.
 *
 *   node scripts/verifyAppServicesInZenoti.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Consultation = require('../models/Consultation');
const Branch = require('../models/Branch');
const zenoti = require('../services/zenotiService');

const isConsultation = (c) => /^consultations?$/i.test(String(c?.category || '').trim())
  || /consultation/i.test(String(c?.name || ''));

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGODB_DB || 'test' });

  const centres = await Branch.find({ isActive: true, zenotiCenterId: { $nin: [null, ''] } })
    .select('name zenotiCenterId').lean();

  // Per centre, so "bookable at Jubilee Hills but not Kondapur" is visible.
  const perCentre = new Map();
  for (const c of centres) {
    const list = await zenoti.getCenterServices(c.zenotiCenterId).catch(() => []);
    perCentre.set(c.name, new Map(list.map((s) => [String(s.id).toLowerCase(), s])));
  }
  const anywhere = new Map();
  perCentre.forEach((m) => m.forEach((s, id) => { if (!anywhere.has(id)) anywhere.set(id, s); }));

  const ours = await Consultation.find({ isArchived: { $ne: true }, inCatalog: true })
    .select('name category zenotiServiceId zenotiServiceName zenotiServiceAuto').lean();

  const ok = []; const partial = []; const broken = []; const blocked = []; const exempt = [];

  for (const c of ours) {
    if (!c.zenotiServiceId) {
      (isConsultation(c) ? exempt : blocked).push(c);
      continue;
    }
    const id = String(c.zenotiServiceId).toLowerCase();
    const live = anywhere.get(id);
    if (!live) { broken.push({ c, why: 'that service id does not exist in Zenoti any more' }); continue; }
    if (live.canBook === false) { broken.push({ c, why: `"${live.name}" exists but Zenoti has it as not bookable` }); continue; }

    const at = centres.filter((x) => perCentre.get(x.name)?.has(id)).map((x) => x.name);
    if (at.length === centres.length) ok.push({ c, live, at });
    else partial.push({ c, live, at });
  }

  const line = (n, total) => `${n} (${total ? Math.round((n / total) * 100) : 0}%)`;
  console.log(`\nAPP CATALOGUE: ${ours.length} services · Zenoti: ${anywhere.size} services across ${centres.length} clinics\n`);
  console.log(`  ✅ bookable at all ${centres.length} clinics : ${line(ok.length, ours.length)}`);
  console.log(`  ⚠️  bookable at SOME clinics only   : ${line(partial.length, ours.length)}`);
  console.log(`  ❌ mapped but BROKEN in Zenoti      : ${line(broken.length, ours.length)}`);
  console.log(`  ⛔ not mapped — booking is refused  : ${line(blocked.length, ours.length)}`);
  console.log(`  ➖ consultations (generic fallback) : ${line(exempt.length, ours.length)}\n`);

  if (broken.length) {
    console.log('BROKEN — these WILL fail when a guest books:');
    broken.forEach(({ c, why }) => console.log(`  ✗ ${String(c.name).padEnd(40)} ${why}`));
    console.log('');
  }
  if (partial.length) {
    console.log('PARTIAL — bookable only at some clinics:');
    partial.forEach(({ c, live, at }) => console.log(`  ⚠ ${String(c.name).slice(0, 38).padEnd(40)} → ${String(live.name).slice(0, 28).padEnd(30)} only at: ${at.join(', ') || 'nowhere'}`));
    console.log('');
  }
  if (blocked.length) {
    console.log(`REFUSED AT BOOKING (${blocked.length}) — the guest is told to call the clinic:`);
    blocked.forEach((c) => console.log(`  ⛔ ${c.name}`));
    console.log('');
  }
  console.log(`VERDICT: ${ok.length + partial.length + exempt.length} of ${ours.length} services can reach Zenoti today.`);
  if (broken.length) console.log(`         ${broken.length} are mapped to something Zenoti will reject — fix these first.`);

  await mongoose.disconnect();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
