/**
 * Give every package its service list from what the clinic actually sold.
 *
 *   node scripts/fillPackagesFromAssignments.js          (preview)
 *   node scripts/fillPackagesFromAssignments.js --apply
 *
 * Zenoti's catalogue API hides package line items, but each purchase
 * (mirrored as a PackageAssignment) lists the services and session counts.
 * A package with an empty service list takes the most common composition
 * seen across its purchases. Database only, idempotent, never touches Zenoti.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { buildMatcher } = require('../utils/catalogueMatch');
const APPLY = process.argv.includes('--apply');
(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const Package = require('../models/Package');
  const PackageAssignment = require('../models/PackageAssignment');
  const Consultation = require('../models/Consultation');
  const consultations = await Consultation.find({}).select('id name price').lean();
  const match = buildMatcher(consultations);
  const empties = await Package.find({ $or: [{ services: { $size: 0 } }, { services: { $exists: false } }] }).select('_id name').lean();
  const out = { empty: empties.length, filled: 0, noPurchases: 0, samples: [] };
  for (const pkg of empties) {
    const rows = await PackageAssignment.find({ packageId: pkg._id, 'sessions.0': { $exists: true } }).select('sessions').lean();
    if (!rows.length) { out.noPurchases += 1; continue; }
    // composition = serviceName → sessions; pick the most frequent composition
    const tally = new Map();
    for (const a of rows) {
      const comp = {};
      for (const s of a.sessions) comp[s.serviceName || '?'] = (comp[s.serviceName || '?'] || 0) + 1;
      const key = JSON.stringify(Object.entries(comp).sort());
      tally.set(key, (tally.get(key) || 0) + 1);
    }
    const [bestKey] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    const services = JSON.parse(bestKey).filter(([n]) => n && n !== '?').map(([name, sessions]) => {
      const c = match(name);
      return { serviceId: c?.id || '', serviceName: c?.name || name, servicePrice: c?.price || 0, sessions };
    });
    if (!services.length) { out.noPurchases += 1; continue; }
    out.filled += 1;
    if (out.samples.length < 8) out.samples.push(`${pkg.name}: ${services.map((s) => `${s.serviceName}×${s.sessions}`).join(', ')}`);
    if (APPLY) await Package.updateOne({ _id: pkg._id }, { $set: { services } });
  }
  console.log(APPLY ? 'APPLIED' : 'PREVIEW', JSON.stringify({ empty: out.empty, filled: out.filled, noPurchases: out.noPurchases }));
  console.log('  e.g.\n  ' + out.samples.join('\n  '));
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
