/**
 * Put every service on ONE taxonomy, and remove the duplicate categories.
 *
 * After the Zenoti master import there were two overlapping taxonomies:
 *
 *   · the app's, hand-written and customer-facing — "Laser Treatments",
 *     "Injectables & Fillers", "Skin Concerns & Minor Procedures" (52 rows);
 *   · Zenoti's, operational — "Body Countouring" (misspelt), "Medical
 *     Treatment", "Procedure", "Others" (760 rows).
 *
 * They are not two lists of the same thing. The app's 52 rows are TREATMENT
 * GROUPS: "Laser Hair Removal (LHR)" is one app row over 39 billable Zenoti
 * services ("LHR abdomen", "LHR beard shaping 1"), "Botox / Neurotoxins" over
 * 13, "Dermal Fillers" over 52. That is why matching them by name found 5 of
 * 52 — they were never the same level.
 *
 * So the shape is three levels, and this script imposes it:
 *
 *   category    the app's own words        Laser Treatments
 *   subCategory the treatment group        Laser Hair Removal (LHR)
 *   name        the billable service       LHR abdomen
 *
 * Zenoti's own Sub Category column is NOT a taxonomy — its values are units and
 * body parts ("Ml", "Unit", "None", "Spa", "Tighs") — so it is cleared and
 * replaced by the group.
 *
 *   node scripts/alignServiceTaxonomy.js            # dry run
 *   node scripts/alignServiceTaxonomy.js --commit
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Consultation = require('../models/Consultation');

const COMMIT = process.argv.includes('--commit');

/** Sub-category values that carry no meaning — units, placeholders, migration junk. */
const JUNK_SUB = ['none', 'ml', 'unit', 'test subcategory', 'migratedservicecat', 'others', 'spa'];
/** Categories that are not categories. */
const JUNK_CAT = ['test category', 'service', 'others'];

/**
 * Categories that mean the same thing. The app's wording wins: it is what a
 * customer reads, and Zenoti's is misspelt or abbreviated.
 */
const CATEGORY_MERGE = {
  laser: 'Laser Treatments',
  'body countouring': 'Skin Tightening & Body Contouring',
  'body contouring': 'Skin Tightening & Body Contouring',
  'skin rejuvenation': 'Skin Tightening & Body Contouring',
  medifacial: 'Facial Treatments',
  'medi facials': 'Facial Treatments',
  'professional peels': 'Chemical Peel',
  'chemical peels': 'Chemical Peel',
  hair: 'Hair Treatment',
  'hair treatments': 'Hair Treatment',
  'semi permanent make up': 'Permanent Makeup & Cosmetic Tattoo',
  'skin brightening': 'Skin Concerns & Minor Procedures',
  'scar treatments': 'Skin Concerns & Minor Procedures',
  'body treatments': 'Skin Tightening & Body Contouring',
  procedure: 'Skin Concerns & Minor Procedures',
  'medical treatment': 'Skin Concerns & Minor Procedures',
  'medical treatments': 'Skin Concerns & Minor Procedures',
  consultations: 'Consultation',
};

/**
 * Treatment groups, in priority order — the FIRST rule that matches a service
 * name wins, so the specific rules are listed before the general ones.
 * [ category, group, pattern ]
 */
const GROUPS = [
  // Named products and procedures first — they are unambiguous. Body parts and
  // generic words come last, because "Dermamelan - Underarms" is a peel, not
  // laser hair removal, and "Add on Serums" is not a blood test.
  ['Chemical Peel', 'Cosmelan / Dermamelan Peel', /cosmelan|cosmelon|dermamelan/i],
  ['Consultation', 'Dermatologist Consultations', /consult|second opinion/i],
  ['Injectables & Fillers', 'Botox / Neurotoxins', /botox|xeomin|dysport|neurotox|botulinum/i],
  ['Injectables & Fillers', 'Dermal Fillers', /filler|juvederm|restylane|teosyal|definisse|volbela|voluma|hylase/i],
  ['Injectables & Fillers', 'Skin Boosters & Biostimulators', /profhilo|prophilo|sculptra|radiesse|monalisa|nctf|skinvive|skin ?booster/i],
  ['Injectables & Fillers', 'Threads', /thread ?lift|\bthreads?\b|\bpdo\b/i],
  ['Mesotherapy & Bio-Stimulation', 'GFC (Growth Factor Concentrate)', /\bgfc\b|growth factor|\bprp\b/i],
  ['Mesotherapy & Bio-Stimulation', 'Exosome Treatments', /exosome/i],
  ['Mesotherapy & Bio-Stimulation', 'Mesotherapy', /mesotherap|\bmeso\b/i],
  ['Mesotherapy & Bio-Stimulation', 'Derma Pen / Micro Needling', /derma ?pen|micro ?need|dermaroller/i],
  ['Mesotherapy & Bio-Stimulation', 'Smart DNA & Retix C', /smart dna|retix|lumiere/i],
  ['Skin Tightening & Body Contouring', 'RF & Microneedling RF', /morpheus|\bmnrf\b|forma|radiofrequen/i],
  ['Skin Tightening & Body Contouring', 'HIFU & Ultrasound Lifting', /\bhifu\b|doublo|ultraformer|ulthera|clear ?lift/i],
  ['Skin Tightening & Body Contouring', 'Body Sculpting & Fat Reduction', /sculpt|cavitation|cryolip|lipoly|fat reduc|inch loss|m ?shape|\bslim/i],
  ['Skin Tightening & Body Contouring', 'Stretch Marks & Scars', /stretch mark|\bscars?\b|keloid|camouflage/i],
  ['Laser Treatments', 'Laser Hair Removal (LHR)', /\blhr\b|laser hair|hair reduction/i],
  ['Laser Treatments', 'Laser Toning & Photo Treatments', /laser ton|photo ?facial|photo ?treat|carbon peel|spectra/i],
  ['Laser Treatments', 'Q-Switch & Pigment Lasers', /q[- ]?switch|\bpico\b|tattoo removal|pigmentary laser/i],
  ['Laser Treatments', 'Fractional & Resurfacing Lasers', /\bco2\b|fractional|erbium|resurfac/i],
  ['Chemical Peel', 'Salicylic & Mandelic Peels', /salicylic|mandelic|nomelan|glycolic|lactic|\btca\b/i],
  ['Chemical Peel', 'Specialty Peels', /\bpeels?\b/i],
  ['Facial Treatments', 'Skin Analysis', /skin analysis|\bvisia\b|skin scan/i],
  ['Facial Treatments', 'Medifacials & Signature Facials', /facial|aqua ?gold|geneo|oxygeneo/i],
  ['Permanent Makeup & Cosmetic Tattoo', 'Eyebrow Services', /eyebrow|microblad|\bbrows?\b/i],
  ['Permanent Makeup & Cosmetic Tattoo', 'Lip Services', /lip (blush|tint|colou?r|pmu|micro)/i],
  ['Permanent Makeup & Cosmetic Tattoo', 'Miscellaneous PMU', /\bpmu\b|permanent make|micropigment|\blash|eyeliner/i],
  ['Hair Treatment', 'Hair Loss & Alopecia', /\bhair\b|alopecia|scalp|minoxidil|folli/i],
  // Lab work: named tests only. A bare "serum" or "profile" is a product line.
  ['Diagnostic Tests', 'Blood & Lab Tests', /blood|\bcbc\b|thyroid|\btsh\b|hba1c|lipid|\blft\b|\brft\b|biopsy|swab|culture|hormone|creatinine|urea|glucose|electrolyte|\bvit(amin)? ?d\b|\bigE\b|amylase/i],
  ['IV Drips & Wellness', 'IV Drips & Injections', /\biv\b|\bdrip|nad\+?|glutathione|vitamin|\binj\b|injection|supplement|myers|\bb12\b/i],
  ['Skin Concerns & Minor Procedures', 'Mole, Wart & Lesion Removal', /\bmole\b|wart|skin tag|milia|\bdpn\b|lesion|cyst|angioma|\bremoval\b/i],
  ['Skin Concerns & Minor Procedures', 'Acne & Active Breakouts', /acne|comedone|extraction|kenacort/i],
  ['Skin Concerns & Minor Procedures', 'Pigmentation & Vascular', /pigment|melasma|\btan\b|vascular|rosacea|bright|\bglow\b|whiten/i],
  ['Add-Ons, Masks & Miscellaneous', 'Masks & Add-Ons', /\bmask|add[- ]?on|\bkit\b|\bnmf\b|\bserums?\b/i],
];

const norm = (v) => String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGODB_DB || 'test' });
  console.log(COMMIT ? '*** COMMIT ***\n' : '--- DRY RUN (nothing written) ---\n');

  const all = await Consultation.find({ isArchived: { $ne: true } })
    .select('name category subCategory inCatalog businessUnit serviceType').lean();
  console.log(`${all.length} live services\n`);

  const plan = new Map(); // id -> { category, subCategory }
  let grouped = 0; let ungrouped = 0;
  const unmatched = [];

  for (const s of all) {
    // 1. The category the app should show it under.
    let category = s.category || '';
    const merged = CATEGORY_MERGE[norm(category)];
    if (merged) category = merged;
    if (JUNK_CAT.includes(norm(category))) category = '';

    // 2. The treatment group. Name first — it is the only reliable signal.
    // The GROUP decides the category. A "Botox 1 Unit" filed under Zenoti's
    // "Medical Treatment" belongs in Injectables & Fillers, whatever the sheet
    // said — otherwise every merged category becomes a dumping ground.
    let group = null;
    for (const [cat, g, rx] of GROUPS) {
      if (rx.test(s.name)) { group = g; category = cat; break; }
    }
    // Zenoti's sub-category is units and body parts; never keep it.
    const oldSub = JUNK_SUB.includes(norm(s.subCategory)) ? null : s.subCategory;

    if (group) grouped += 1;
    else { ungrouped += 1; if (unmatched.length < 25) unmatched.push(s); }

    const nextCategory = category || 'Add-Ons, Masks & Miscellaneous';
    /*
     * Everything gets a group. The ~90 rows no rule recognises are real
     * services ("Glass Rejuvenation", "Freckles", "Patch Test") that simply do
     * not belong to a named group yet — filing them under "Other" in their own
     * category keeps the app's filters complete and makes the backlog visible
     * as one bucket someone can work through, rather than as blanks.
     */
    const nextSub = group || oldSub || 'Other';
    if (nextCategory !== s.category || nextSub !== (s.subCategory ?? null)) {
      plan.set(String(s._id), { category: nextCategory, subCategory: nextSub });
    }
  }

  console.log(`  routed into a treatment group : ${grouped}`);
  console.log(`  no group matched              : ${ungrouped}`);
  console.log(`  rows changing                 : ${plan.size}\n`);

  // What the taxonomy becomes.
  const after = new Map();
  all.forEach((s) => {
    const p = plan.get(String(s._id)) || { category: s.category, subCategory: s.subCategory };
    const k = p.category || '—';
    if (!after.has(k)) after.set(k, { n: 0, subs: new Set() });
    after.get(k).n += 1;
    if (p.subCategory) after.get(k).subs.add(p.subCategory);
  });
  console.log(`CATEGORIES AFTER: ${after.size} (was ${new Set(all.map((s) => s.category)).size})`);
  [...after.entries()].sort((a, b) => b[1].n - a[1].n).forEach(([c, v]) => {
    console.log(`  ${String(v.n).padStart(4)}  ${c.padEnd(38)} ${v.subs.size} groups`);
  });

  if (process.argv.includes('--samples')) {
    const byGroup = new Map();
    all.forEach((s) => {
      const p = plan.get(String(s._id)) || { category: s.category, subCategory: s.subCategory };
      const k = `${p.category} › ${p.subCategory || '(no group)'}`;
      byGroup.set(k, [...(byGroup.get(k) || []), s.name]);
    });
    console.log('\nSAMPLES PER GROUP:');
    [...byGroup.entries()].sort((a, b) => b[1].length - a[1].length).forEach(([k, names]) => {
      console.log(`  ${String(names.length).padStart(4)}  ${k}`);
      console.log(`        ${names.slice(0, 4).join(' | ').slice(0, 120)}`);
    });
  }

  if (unmatched.length) {
    console.log('\nNo group rule matched these (they keep their category):');
    unmatched.forEach((s) => console.log(`  · ${String(s.name).slice(0, 60)}`));
  }

  if (COMMIT) {
    const ops = [...plan.entries()].map(([id, set]) => ({
      updateOne: { filter: { _id: new mongoose.Types.ObjectId(id) }, update: { $set: set } },
    }));
    for (let i = 0; i < ops.length; i += 500) {
      await Consultation.bulkWrite(ops.slice(i, i + 500));
    }
    // Zenoti's own columns, filled for the app's own rows so an export is complete.
    await Consultation.updateMany(
      { isArchived: { $ne: true }, $or: [{ businessUnit: null }, { businessUnit: '' }] },
      { $set: { businessUnit: 'Default' } },
    );
    await Consultation.updateMany(
      { isArchived: { $ne: true }, $or: [{ serviceType: null }, { serviceType: '' }] },
      { $set: { serviceType: 'None' } },
    );
    console.log(`\nwrote ${ops.length} services`);
  }

  await mongoose.disconnect();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
