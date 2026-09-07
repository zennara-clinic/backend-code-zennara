/**
 * Give EVERY published service a Zenoti service to book against.
 *
 * Without one, resolveServiceId() returns null, the push is recorded as
 * `skipped`, and the guest keeps a confirmation for an appointment the clinic
 * never hears about. Three of the four bookings ever made outside Zenoti failed
 * exactly that way.
 *
 * The catalogues are at different granularity: the app sells GROUPS ("Doublo
 * HIFU") and Zenoti bills VARIANTS ("Doublo HIFU-Abdomen", "-Double Chin", 20
 * of them). A group therefore needs a DEFAULT — the line an app booking is
 * raised against unless the desk changes it at check-in. This picks that
 * default rather than leaving the service unbookable, on the instruction that
 * every appointment must reach Zenoti.
 *
 * How the default is chosen, in order:
 *   1. an exact name or code match;
 *   2. otherwise the candidate sharing the most distinctive words, preferring
 *      the SHORTEST name — the base variant ("Botox" over "Botox 1 Unit.."),
 *      which is the least surprising thing to bill by default;
 *   3. staff lines, per-doctor variants and test rows are never chosen.
 *
 * Every automatic choice is stamped `zenotiServiceAuto: true` with the
 * alternatives kept on the record, so the panel can show "chosen for you —
 * confirm" and a person can correct it in one click. Nothing here is
 * irreversible: re-running with a filled review sheet overwrites it.
 *
 *   node scripts/mapAllServicesToZenoti.js            # dry run
 *   node scripts/mapAllServicesToZenoti.js --commit
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Consultation = require('../models/Consultation');
const Branch = require('../models/Branch');
const zenoti = require('../services/zenotiService');
const { buildMatcher } = require('../utils/catalogueMatch');

const COMMIT = process.argv.includes('--commit');
const norm = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Words that describe packaging or process, not the treatment itself. */
const NOISE = new Set([
  'treatment', 'treatments', 'therapy', 'therapies', 'service', 'services', 'session', 'sessions',
  'package', 'packages', 'per', 'unit', 'units', 'ml', 'the', 'and', 'with', 'for', 'plus',
  'general', 'miscellaneous', 'misc', 'other', 'others', 'full', 'new',
]);

/** Distinctive words in a name, plus any bracketed acronym. */
function tokens(name) {
  const acronyms = (String(name).match(/\(([A-Za-z0-9+]{2,8})\)/g) || [])
    .map((a) => a.replace(/[()]/g, '').toLowerCase());
  const words = String(name).toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9+]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 2 && !NOISE.has(w));
  return new Set([...words, ...acronyms]);
}

/**
 * Never book a guest against an internal, per-practitioner or test line.
 * Zenoti writes those several ways: "- DR Rickson", "/Dr.Rickson", "By Arti".
 */
const INTERNAL = /\b(staff|internal|test|demo|trial|training)\b|[-/]\s*dr\.?\s*\w|\bdr\.?\s+\w+\s*$|\bby\s+\w+\s*$/i;

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGODB_DB || 'test' });
  console.log(COMMIT ? '*** COMMIT ***\n' : '--- DRY RUN (nothing written) ---\n');

  const centres = await Branch.find({ isActive: true, zenotiCenterId: { $nin: [null, ''] } })
    .select('name zenotiCenterId').lean();
  const byId = new Map();
  for (const c of centres) {
    const list = await zenoti.getCenterServices(c.zenotiCenterId).catch(() => []);
    list.forEach((s) => { if (s.id && !byId.has(s.id)) byId.set(s.id, s); });
  }
  const all = [...byId.values()];
  /*
   * Zenoti's own can_book flag is the difference between a mapping that looks
   * right and one that works. "Pico Laser", "Hifu", "Botox", "GFC Face" and
   * "Exosome 5ml" all exist and match perfectly by name — and Zenoti refuses to
   * book any of them. Mapping onto one produces a failure at the exact moment a
   * guest is waiting for a confirmation, so they are excluded outright.
   */
  const bookable = all.filter((s) => !INTERNAL.test(String(s.name || '')) && s.canBook !== false);
  const notBookable = all.filter((s) => s.canBook === false).length;
  console.log(`Zenoti: ${all.length} services · ${notBookable} flagged not-bookable · ${bookable.length} usable\n`);

  const ours = await Consultation.find({ isArchived: { $ne: true }, inCatalog: true })
    .select('id name code category subCategory zenotiServiceId').lean();

  const exact = buildMatcher(bookable, (s) => s.name, { strict: true });
  const byCode = new Map(bookable.filter((s) => s.code).map((s) => [norm(s.code), s]));

  const plan = []; const stuck = [];

  for (const c of ours) {
    if (c.zenotiServiceId) {
      // Keep an existing mapping only if it still points at something Zenoti
      // will actually book; otherwise fall through and find a replacement.
      const cur = byId.get(String(c.zenotiServiceId).toLowerCase());
      if (cur && cur.canBook !== false && !INTERNAL.test(String(cur.name || ''))) {
        plan.push({ c, z: null, how: 'already mapped', alts: [] });
        continue;
      }
      console.log(`  ! remapping "${c.name}" — current target ${cur ? `"${cur.name}" is not bookable` : 'no longer exists'}`);
    }

    const viaCode = c.code ? byCode.get(norm(c.code)) : null;
    if (viaCode) { plan.push({ c, z: viaCode, how: 'code', alts: [] }); continue; }

    const viaName = exact(c.name);
    if (viaName) { plan.push({ c, z: viaName, how: 'exact name', alts: [] }); continue; }

    // Score every Zenoti service by how much of OUR name it accounts for.
    const want = tokens(c.name);
    if (!want.size) { stuck.push({ c, why: 'no distinctive words in the name' }); continue; }

    const scored = bookable.map((z) => {
      const have = tokens(z.name);
      let hit = 0;
      want.forEach((t) => { if (have.has(t)) hit += 1; });
      return {
        z,
        score: hit / want.size,
        // How much of ZENOTI's name we account for. A short Zenoti name fully
        // contained in ours is a strong signal the other way round: "Derma Pen
        // / Micro Needling" only covers 50% of its own words with "Derma Pen
        // Treatment", but that Zenoti line is 100% accounted for by ours.
        covers: have.size ? hit / have.size : 0,
        zTokens: have.size,
        len: String(z.name).length,
      };
    }).filter((x) => x.score > 0)
      // Best coverage first; then the SHORTEST name, which is the base variant
      // rather than a body-part or dose-specific line.
      .sort((a, b) => (b.score - a.score) || (a.len - b.len));

    if (!scored.length) { stuck.push({ c, why: 'nothing in Zenoti shares a word with this name' }); continue; }

    /*
     * A weak match is worse than none.
     *
     * "Skin Boosters & Biostimulators" and "Skin biopsy" share the word "skin";
     * "Body Sculpting & Fat Reduction" and "LHR full body" share "body". Booking
     * a guest onto either would send them for the wrong procedure and bill the
     * wrong amount — a failure the clinic notices in the room, which is worse
     * than a booking that never left. So a mapping is only accepted when it is
     * strong (most of our name accounted for) or when the Zenoti line clearly
     * IS the thing: a short name whose first distinctive word starts theirs
     * ("Botox / Neurotoxins" → "Botox").
     */
    const best = scored[0];
    const first = [...want][0];
    const startsWithOurs = first && new RegExp(`^${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(String(best.z.name).trim());
    /*
     * A one-word name needs more than a shared word. "Body Treatments" reduces
     * to {body}, which "LHR full body" contains in full — a 100% score for a
     * laser hair removal line. So a single token only counts when it is
     * distinctive enough to stand alone ("eyeliner", not "body") or when the
     * Zenoti name actually begins with it.
     */
    const single = want.size === 1;
    const distinctive = single && first && first.length >= 6 && best.score === 1;
    /*
     * A Zenoti line whose every distinctive word appears in ours is the same
     * thing said shorter — provided it has at least two such words. One word
     * is not enough: "ZO Facials" reduces to {facials}, which "Medifacials &
     * Signature Facials" contains, yet ZO is a particular brand of facial.
     */
    const containedInOurs = best.covers === 1 && best.zTokens >= 2;
    const confident = (want.size >= 2 && best.score >= 0.6)
      || (want.size <= 2 && startsWithOurs)
      || containedInOurs
      || distinctive;
    if (!confident) {
      stuck.push({ c, why: `closest is "${best.z.name}" at only ${Math.round(best.score * 100)}% — too weak to book against` });
      continue;
    }
    plan.push({
      c, z: best.z, how: `${Math.round(best.score * 100)}% of the name`,
      alts: scored.slice(1, 6).map((x) => ({ id: x.z.id, name: x.z.name })),
      auto: true,
    });
  }

  const fresh = plan.filter((p) => p.z);
  console.log(`PUBLISHED SERVICES: ${ours.length}`);
  console.log(`  already mapped        : ${plan.filter((p) => !p.z).length}`);
  console.log(`  mapping now           : ${fresh.length}`);
  console.log(`  still cannot be mapped: ${stuck.length}\n`);

  fresh.forEach(({ c, z, how, auto }) => {
    console.log(`  ${auto ? '~' : '✓'} ${String(c.name).slice(0, 36).padEnd(38)} → ${String(z.name).slice(0, 36).padEnd(38)} [${how}]`);
  });
  if (stuck.length) {
    console.log('\nSTILL UNMAPPED:');
    stuck.forEach(({ c, why }) => console.log(`  ✗ ${String(c.name).padEnd(38)} ${why}`));
  }

  if (COMMIT) {
    for (const { c, z, auto, alts } of fresh) {
      await Consultation.updateOne({ _id: c._id }, {
        $set: {
          zenotiServiceId: String(z.id).toLowerCase(),
          zenotiServiceName: z.name,
          zenotiCanBook: z.canBook !== false,
          zenotiServiceAuto: !!auto,
          zenotiServiceAlternatives: alts,
          ...(z.code && !c.code ? { code: z.code } : {}),
        },
      });
    }
    const total = await Consultation.countDocuments({
      isArchived: { $ne: true }, inCatalog: true, zenotiServiceId: { $nin: [null, ''] },
    });
    console.log(`\nwrote ${fresh.length}. ${total} of ${ours.length} published services can now reach Zenoti.`);
    console.log(`${fresh.filter((f) => f.auto).length} were chosen automatically and are flagged for the clinic to confirm.`);
  }

  await mongoose.disconnect();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
