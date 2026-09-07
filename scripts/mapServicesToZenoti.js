/**
 * Point every published service at a real Zenoti service, so app bookings
 * actually reach the clinic.
 *
 * A booking is pushed by resolveServiceId(), which needs the Zenoti service id
 * to book against. Without one the push never happens: the booking is recorded
 * as `skipped` with "No Zenoti service is mapped to …", the guest gets a
 * confirmation, and the clinic's diary never hears about it. Three of the four
 * bookings ever made outside Zenoti failed exactly this way. The fourth was a
 * Consultation, which survives only because resolveServiceId has a special
 * fallback to Zenoti's generic "Consultation" row.
 *
 * The hard part is that our published rows are TREATMENT GROUPS — "GFC (Growth
 * Factor Concentrate)" stands over Zenoti's "GFC 1", "GFC Hair", "GFC Face" —
 * so a group has to be pointed at ONE billable service. That is a clinical
 * decision, so this never guesses between several: it maps only what is
 * unambiguous, and prints the candidates for the rest.
 *
 *   node scripts/mapServicesToZenoti.js            # dry run + proposal
 *   node scripts/mapServicesToZenoti.js --commit   # write the certain ones
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Consultation = require('../models/Consultation');
const Branch = require('../models/Branch');
const zenoti = require('../services/zenotiService');
const { buildMatcher } = require('../utils/catalogueMatch');

const COMMIT = process.argv.includes('--commit');
const norm = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
/** Words that carry no meaning when matching a group to a billable line. */
const NOISE = /\b(treatments?|therapy|services?|packages?|sessions?|per|unit|units|ml|staff|dr|for|the|and|with|of)\b/gi;
const keyOf = (v) => String(v || '').toLowerCase()
  .replace(/\(.*?\)/g, ' ')
  .replace(NOISE, ' ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGODB_DB || 'test' });
  console.log(COMMIT ? '*** COMMIT ***\n' : '--- DRY RUN (nothing written) ---\n');

  // Zenoti's bookable services, across the three clinics.
  const centres = await Branch.find({ isActive: true, zenotiCenterId: { $nin: [null, ''] } })
    .select('name zenotiCenterId').lean();
  const byId = new Map();
  for (const c of centres) {
    const list = await zenoti.getCenterServices(c.zenotiCenterId).catch(() => []);
    list.forEach((s) => { if (s.id && !byId.has(s.id)) byId.set(s.id, s); });
  }
  /*
   * Staff lines and per-doctor variants are not what a guest books.
   * "Peels for Staff" and "Doublo HIFU-Abdomen- DR Rickson" exist for internal
   * billing; auto-mapping a guest-facing treatment onto one would book every
   * app customer against a staff rate or a specific doctor's list.
   */
  const INTERNAL = /\b(staff|internal|test|demo|complimentary)\b|-\s*dr[.\s]|\bdr\s+\w+\s*$/i;
  const zServices = [...byId.values()].filter((s) => !INTERNAL.test(String(s.name || '')));
  console.log(`Zenoti offers ${zServices.length} distinct services across ${centres.length} clinics\n`);

  const ours = await Consultation.find({ isArchived: { $ne: true }, inCatalog: true })
    .select('id name code category subCategory zenotiServiceId').lean();

  const exact = buildMatcher(zServices, (s) => s.name, { strict: true });
  const byCode = new Map(zServices.filter((s) => s.code).map((s) => [norm(s.code), s]));

  const already = []; const mapped = []; const ambiguous = []; const none = [];

  for (const c of ours) {
    if (c.zenotiServiceId) { already.push(c); continue; }

    // 1. Code is the reliable key when we have one.
    const viaCode = c.code ? byCode.get(norm(c.code)) : null;
    if (viaCode) { mapped.push({ c, z: viaCode, how: 'code' }); continue; }

    // 2. An exact name match is safe.
    const viaName = exact(c.name);
    if (viaName) { mapped.push({ c, z: viaName, how: 'exact name' }); continue; }

    /*
     * 3. Otherwise this is a group standing over several billable lines.
     *
     * Substring matching is useless here: our "Laser Hair Removal (LHR)" and
     * Zenoti's "LHR abdomen" share no substring, and "Botox / Neurotoxins"
     * shares none with "Botox 1 Unit". Score on shared distinctive TOKENS
     * instead, plus any acronym in brackets — that is what actually connects
     * the two vocabularies.
     */
    const acronyms = (String(c.name).match(/\(([A-Z0-9]{2,6})\)/g) || [])
      .map((a) => a.replace(/[()]/g, '').toLowerCase());
    const tokens = new Set([...keyOf(c.name).split(' ').filter((t) => t.length > 2), ...acronyms]);
    const scored = tokens.size
      ? zServices.map((z) => {
        const zt = new Set(keyOf(z.name).split(' ').filter(Boolean));
        let hit = 0;
        tokens.forEach((t) => { if (zt.has(t)) hit += 1; });
        return { z, score: hit / tokens.size };
      }).filter((x) => x.score >= 0.5).sort((a, b) => b.score - a.score)
      : [];
    const candidates = scored.map((x) => x.z);
    // Only auto-map a lone candidate that matched EVERY token — a partial match
    // with one survivor is a coincidence, not a mapping.
    if (candidates.length === 1 && scored[0].score === 1) { mapped.push({ c, z: candidates[0], how: 'only exact candidate' }); continue; }
    if (candidates.length > 1) { ambiguous.push({ c, candidates }); continue; }
    none.push(c);
  }

  console.log(`PUBLISHED SERVICES: ${ours.length}`);
  console.log(`  already mapped              : ${already.length}`);
  console.log(`  can be mapped automatically : ${mapped.length}`);
  console.log(`  need a person to choose     : ${ambiguous.length}`);
  console.log(`  nothing in Zenoti matches   : ${none.length}\n`);

  if (mapped.length) {
    console.log('WILL MAP (unambiguous):');
    mapped.forEach(({ c, z, how }) => console.log(`  ${String(c.name).slice(0, 38).padEnd(40)} → ${String(z.name).slice(0, 34).padEnd(36)} [${how}]`));
    console.log('');
  }

  if (ambiguous.length) {
    console.log('NEEDS A DECISION — a group over several billable lines:');
    ambiguous.forEach(({ c, candidates }) => {
      console.log(`  ${c.name}  (${candidates.length} candidates)`);
      candidates.slice(0, 6).forEach((z) => console.log(`       ${z.id}  ${z.name}`));
      if (candidates.length > 6) console.log(`       … and ${candidates.length - 6} more`);
    });
    console.log('');
  }

  if (none.length) {
    console.log('NO MATCH IN ZENOTI AT ALL:');
    none.forEach((c) => console.log(`  ${c.name}`));
    console.log('');
  }

  /*
   * The review sheet.
   *
   * Automatic matching gets nowhere near all of these, and that is structural
   * rather than a weak matcher: the app sells GROUPS ("Doublo HIFU") and Zenoti
   * bills VARIANTS ("Doublo HIFU-Abdomen", "-Double Chin", 20 of them). Only
   * the clinic can say which line an app booking should be raised against, so
   * the job is to put that decision in front of them once, with the candidates
   * already found, rather than to guess.
   */
  if (process.argv.includes('--csv')) {
    const fs = require('fs');
    const esc = (v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
    const lines = [['AppService', 'Category', 'CurrentZenotiServiceId', 'ChooseZenotiServiceId', 'Candidate1Id', 'Candidate1Name', 'Candidate2Name', 'Candidate3Name', 'OtherCandidates'].join(',')];
    const row = (c, cands, current) => lines.push([
      c.name, c.category, current || '', '',
      cands[0]?.id || '', cands[0]?.name || '', cands[1]?.name || '', cands[2]?.name || '',
      cands.length > 3 ? `+${cands.length - 3} more` : '',
    ].map(esc).join(','));
    already.forEach((c) => row(c, [], c.zenotiServiceId));
    mapped.forEach(({ c, z }) => row(c, [z], z.id));
    ambiguous.forEach(({ c, candidates }) => row(c, candidates, ''));
    none.forEach((c) => row(c, [], ''));
    const out = 'zenoti-service-mapping-review.csv';
    fs.writeFileSync(out, `\ufeff${lines.join('\n')}\n`);
    console.log(`review sheet written: ${out} (${lines.length - 1} services)`);
  }

  if (COMMIT && mapped.length) {
    for (const { c, z } of mapped) {
      await Consultation.updateOne({ _id: c._id }, {
        $set: { zenotiServiceId: String(z.id).toLowerCase(), ...(z.code && !c.code ? { code: z.code } : {}) },
      });
    }
    const total = await Consultation.countDocuments({ isArchived: { $ne: true }, inCatalog: true, zenotiServiceId: { $nin: [null, ''] } });
    console.log(`wrote ${mapped.length}; ${total} of ${ours.length} published services can now reach Zenoti`);
  }

  await mongoose.disconnect();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
