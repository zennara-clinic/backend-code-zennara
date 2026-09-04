/**
 * File the granular Zenoti services under the clinic's own treatment families.
 *
 *   node scripts/fileZenotiServicesUnderCategories.js          (preview)
 *   node scripts/fileZenotiServicesUnderCategories.js --apply
 *
 * The app lists ~55 treatment FAMILIES ("Laser Toning & Photo Treatments");
 * Zenoti bills ~550 specific services ("Laser Toning Face"). Each Zenoti
 * service is already mirrored as a hidden row linked by id; this puts that row
 * in the same category as the family whose words it contains, so the panel
 * sees "Laser Toning Face" filed under Laser Treatments instead of
 * "Uncategorised". Bookings still without a treatment (the Zenoti service was
 * renamed or retired) are linked to the family the same way. Unique hits only.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { coreTokens } = require('../utils/catalogueMatch');
const APPLY = process.argv.includes('--apply');
const GENERIC = new Set(['treatments', 'treatment', 'services', 'service', 'packages', 'package', 'and', 'therapy', 'general', 'other', 'miscellaneous', 'specialty']);

function familyKeys(name) {
  // "Laser Hair Removal (LHR)" → [[laser,hair,removal],[lhr]]; "Forma / RF Treatments" → [[forma],[rf]]
  const aliases = [...String(name).matchAll(/\(([^)]+)\)/g)].map((m) => m[1]);
  const main = String(name).replace(/\([^)]*\)/g, '');
  return [...main.split(/\s*[\/–-]\s*|\s+&\s+/), ...aliases]
    .map((part) => coreTokens(part).filter((w) => !GENERIC.has(w)))
    .filter((t) => t.length);
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const Consultation = require('../models/Consultation');
  const Booking = require('../models/Booking');
  const families = (await Consultation.find({ isActive: true }).select('_id name category').lean())
    .map((f) => ({ ...f, keys: familyKeys(f.name) }));
  const familyFor = (name) => {
    const have = new Set(coreTokens(name));
    const hits = families.filter((f) => f.keys.some((k) => k.every((w) => have.has(w))));
    // prefer the family with the longest matching key (more specific wins)
    if (!hits.length) return null;
    const scored = hits.map((f) => ({ f, len: Math.max(...f.keys.filter((k) => k.every((w) => have.has(w))).map((k) => k.length)) }));
    const best = Math.max(...scored.map((s) => s.len));
    const top = scored.filter((s) => s.len === best);
    if (top.length !== 1) return null;
    const fam = top[0].f;
    // Words that change what a thing IS: a hair botox is not a neurotoxin
    // treatment, a lip filler is a filler, not a PMU lip service.
    const n = String(name).toLowerCase();
    const fn = String(fam.name).toLowerCase();
    if (/hair botox/.test(n)) return null;
    if (/filler/.test(n) && !/filler/.test(fn)) return null;
    if (/peel/.test(n) && !/peel/.test(fn)) return null;
    return fam;
  };

  const shells = await Consultation.find({ isActive: false, category: 'Uncategorised' }).select('_id name').lean();
  const filed = { total: shells.length, filed: 0, byCategory: {}, samples: [], left: [] };
  const ops = [];
  for (const s of shells) {
    const fam = familyFor(s.name);
    if (!fam) { filed.left.push(s.name); continue; }
    filed.filed += 1; filed.byCategory[fam.category] = (filed.byCategory[fam.category] || 0) + 1;
    if (filed.samples.length < 12) filed.samples.push(`${s.name} → ${fam.name} [${fam.category}]`);
    ops.push({ updateOne: { filter: { _id: s._id }, update: { $set: { category: fam.category } } } });
  }
  if (APPLY && ops.length) await Consultation.bulkWrite(ops, { ordered: false });

  const orphan = await Booking.find({ $or: [{ consultationId: null }, { consultationId: { $exists: false } }], externalServiceName: { $nin: [null, ''] } }).select('_id externalServiceName').lean();
  const bk = { total: orphan.length, linked: 0, samples: [], left: {} };
  const bops = [];
  for (const b of orphan) {
    const fam = familyFor(b.externalServiceName);
    if (!fam) { bk.left[b.externalServiceName] = (bk.left[b.externalServiceName] || 0) + 1; continue; }
    bk.linked += 1;
    if (bk.samples.length < 10 && !bk.samples.some((x) => x.startsWith(b.externalServiceName))) bk.samples.push(`${b.externalServiceName} → ${fam.name}`);
    bops.push({ updateOne: { filter: { _id: b._id }, update: { $set: { consultationId: fam._id } } } });
  }
  if (APPLY && bops.length) await Booking.bulkWrite(bops, { ordered: false });

  console.log(APPLY ? 'APPLIED' : 'PREVIEW');
  console.log(`services: ${filed.filed}/${filed.total} filed`, JSON.stringify(filed.byCategory));
  console.log('  e.g.', filed.samples.join('\n       '));
  console.log('  still uncategorised (first 30):', filed.left.slice(0, 30).join(' | '));
  console.log(`bookings: ${bk.linked}/${bk.total} linked to a family`);
  console.log('  e.g.', bk.samples.join('\n       '));
  console.log('  left:', Object.entries(bk.left).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([n, c]) => `${n} (${c})`).join(' | '));
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
