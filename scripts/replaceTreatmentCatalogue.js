/**
 * Replace the app's treatment catalogue with data/treatmentCatalogue.js (2026-09).
 *
 *   node scripts/replaceTreatmentCatalogue.js            # dry run: prints the plan, writes nothing
 *   node scripts/replaceTreatmentCatalogue.js --commit   # backs up, then writes
 *
 * 1. RETIRE — every treatment published to the app is archived IN PLACE
 *    (inCatalog false, isArchived true, archivedAt, archivedReason). Nothing is deleted
 *    and nothing moves collection: bookings, packages, memberships and the Zenoti mirrors
 *    resolve services by _id / id, archived or not. The two consultation-flow rows are
 *    never touched — consultation checkout prices itself from them.
 * 2. MENU — the nine categories are filed under one level-1 type, "Treatments" (created if
 *    missing), in menu order with their icon keys. A category of the same name is reused.
 * 3. PUBLISH — the new treatments go live with fresh copy and no photo (the clinic uploads
 *    those from the panel). Each takes the operational wiring of the old service it
 *    replaces — Zenoti link, booking charge, price shown or hidden, tax, centre prices,
 *    prerequisites — so booking behaves exactly as before. A treatment with no Zenoti link
 *    cannot be booked in the app (the server tells the guest to call); they are listed.
 *
 * Safe to re-run: rows this script created (catalogAddedBy = MARK) are recognised and only
 * their copy, category, conditions and order are refreshed — never a photo, price or
 * Zenoti link the panel has set since.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Consultation = require('../models/Consultation');
const Category = require('../models/Category');
const ServiceType = require('../models/ServiceType');
const Booking = require('../models/Booking');
const { treatments, categories } = require('../data/treatmentCatalogue');
const { TREATMENT_TYPE, normaliseConditions, slugify } = require('../utils/treatmentTaxonomy');

const COMMIT = process.argv.includes('--commit');
const MARK = 'catalogue-2026-09';
const REASON = 'Replaced by the 2026-09 treatment catalogue';
/** The two rows the consultation flow resolves by slug. Never retire these. */
const KEEP_SLUGS = ['senior-dermatologist-consultation', 'dermatologist-consultation'];
/** Wiring a new treatment takes from the service it replaces. Never content, never photos. */
const CARRIED = ['price', 'showPriceInApp', 'chargeOnlineBooking', 'taxPercent', 'priceIncludesTax', 'centrePrices', 'prerequisites', 'eligibleDoctorIds'];
const ZENOTI = ['zenotiServiceId', 'zenotiServiceName', 'zenotiServiceAuto', 'zenotiServiceAlternatives', 'zenotiCanBook'];
/** On a re-run, what the script may refresh on a row it created. */
const COPY = ['name', 'type', 'category', 'summary', 'about', 'key_benefits', 'ideal_for', 'pre_care', 'post_care', 'faqs', 'conditions', 'displayOrder'];

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const pick = (doc, keys) => Object.fromEntries(keys.filter((k) => doc && doc[k] !== undefined).map((k) => [k, doc[k]]));
const bookable = (d) => !!d.zenotiServiceId && d.zenotiCanBook !== false;

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGODB_DB || 'test' });
  console.log(COMMIT ? '*** COMMIT ***\n' : '--- DRY RUN (nothing is written; add --commit) ---\n');
  const problems = [];

  // ── What is published now ──────────────────────────────────────────────────────────
  const published = await Consultation.find({ inCatalog: true, isArchived: { $ne: true } }).lean();
  const ours = new Map((await Consultation.find({ catalogAddedBy: MARK }).lean()).map((d) => [d.slug, d]));
  const keep = published.filter((d) => KEEP_SLUGS.includes(d.slug));
  if (keep.length !== KEEP_SLUGS.length) problems.push(`expected both consultation-flow rows published, found ${keep.length}`);
  const retire = published.filter((d) => !KEEP_SLUGS.includes(d.slug) && d.catalogAddedBy !== MARK);

  // ── Sources for the carried wiring (old rows may already be archived on a re-run) ──
  const sourceFor = async (name) => Consultation.findOne({
    name, $or: [{ inCatalog: true, isArchived: { $ne: true }, catalogAddedBy: { $ne: MARK } }, { archivedReason: REASON }],
  }).lean();
  const zenotiFor = async (name) => Consultation.findOne({ name, zenotiServiceId: { $type: 'string', $ne: '' } }).sort({ isArchived: 1 }).lean();

  // ── Build every new row and prove it valid before anything is written ─────────────
  const categoryName = new Map(categories.map((c) => [c.key, c.name]));
  const seen = new Set();
  const rows = [];
  for (const [i, t] of treatments.entries()) {
    if (seen.has(t.slug)) problems.push(`duplicate slug ${t.slug}`);
    seen.add(t.slug);
    if (!categoryName.has(t.category)) problems.push(`${t.slug}: unknown category ${t.category}`);
    const conditions = normaliseConditions(t.conditions);
    if (conditions.length !== t.conditions.length) problems.push(`${t.slug}: unknown condition in ${t.conditions.join(',')}`);
    if (/consult|counsel/i.test(t.name)) problems.push(`${t.slug}: a name with "consult" is treated as a consultation everywhere`);

    const src = t.replaces ? await sourceFor(t.replaces) : null;
    if (t.replaces && !src) problems.push(`${t.slug}: the service it replaces, "${t.replaces}", was not found`);
    const zsrc = t.zenoti ? await zenotiFor(t.zenoti) : null;
    if (t.zenoti && !zsrc) problems.push(`${t.slug}: no Zenoti-linked service named "${t.zenoti}"`);

    const doc = {
      id: t.slug, slug: t.slug, name: t.name,
      type: TREATMENT_TYPE, category: categoryName.get(t.category), subCategory: null,
      summary: t.summary, about: t.about,
      key_benefits: t.benefits, ideal_for: t.idealFor, pre_care: t.preCare, post_care: t.postCare,
      faqs: t.faqs.map(([q, a]) => ({ q, a })),
      tags: [], conditions,
      image: '', media: [],
      duration_minutes: t.duration ?? null, recovery_minutes: 0,
      displayOrder: i + 1, isPopular: !!t.popular, cta_label: 'Book Consultation',
      isActive: true, inCatalog: true, isArchived: false, archivedAt: null, archivedReason: null,
      catalogAddedAt: new Date(), catalogAddedBy: MARK,
      price: 0, showPriceInApp: false, chargeOnlineBooking: true,
      ...pick(src, CARRIED),
      ...pick(src || zsrc, ZENOTI),
    };
    // Name the Zenoti service when the source only had its id (the mirror row IS the name).
    if (doc.zenotiServiceId && !doc.zenotiServiceName) {
      const mirror = zsrc || await Consultation.findOne({ zenotiServiceId: doc.zenotiServiceId, inCatalog: { $ne: true } }).select('name').lean();
      if (mirror) doc.zenotiServiceName = mirror.name;
    }
    const err = new Consultation(doc).validateSync();
    if (err) problems.push(`${t.slug}: ${err.message}`);
    rows.push({ t, doc, src, zsrc, existing: ours.get(t.slug) || null });
  }

  // Slugs and ids are unique across archived rows too — a taken one must be ours.
  const taken = await Consultation.find({ $or: [{ slug: { $in: [...seen] } }, { id: { $in: [...seen] } }] }).select('slug id name catalogAddedBy').lean();
  for (const d of taken) if (d.catalogAddedBy !== MARK) problems.push(`slug/id "${d.slug}" is already used by "${d.name}" — rename the new treatment`);

  // ── Menu: one type, nine categories ─────────────────────────────────────────────────
  const typeDoc = await ServiceType.findOne({ name: TREATMENT_TYPE }).lean();
  const catPlan = [];
  for (const c of categories) {
    const doc = await Category.findOne({ name: new RegExp(`^${c.name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`, 'i') }).lean();
    catPlan.push({ c, doc });
  }

  // ── Report ──────────────────────────────────────────────────────────────────────────
  console.log(`KEEP (consultation flow): ${keep.map((d) => d.name).join(' · ')}`);
  console.log(`\nRETIRE — ${retire.length} published services, archived in place:`);
  for (const d of retire) {
    // eslint-disable-next-line no-await-in-loop
    const n = await Booking.countDocuments({ consultationId: d._id });
    console.log(`  · ${String(d.name).padEnd(44)} ${String(d.category).padEnd(36)} bookings=${n}`);
  }
  console.log(`\nMENU — type "${TREATMENT_TYPE}" ${typeDoc ? 'exists' : 'will be created'}; categories:`);
  for (const { c, doc } of catPlan) console.log(`  ${String(c.order).padStart(2)}. ${c.name.padEnd(24)} icon=${c.icon.padEnd(22)} ${doc ? `reuse (was type=${doc.type}, active=${doc.isActive})` : 'create'}`);
  console.log(`\nPUBLISH — ${rows.length} treatments:`);
  let cat = '';
  for (const { t, doc, src, zsrc, existing } of rows) {
    if (doc.category !== cat) { cat = doc.category; console.log(`  ${cat}`); }
    const from = src ? `← ${src.name}` : zsrc ? `← Zenoti "${zsrc.name}"` : '← (nothing to carry)';
    const flag = bookable(doc) ? `bookable via "${doc.zenotiServiceName}"` : 'NOT bookable in the app (no Zenoti link)';
    console.log(`     ${existing ? 'refresh' : 'create '} ${t.name.padEnd(32)} ${from.padEnd(42)} ₹${doc.price}${doc.showPriceInApp ? ' shown' : ''}  ${flag}`);
  }
  const notBookable = rows.filter((r) => !bookable(r.doc)).map((r) => r.t.name);
  console.log(`\n${rows.length - notBookable.length} of ${rows.length} bookable in the app; not bookable: ${notBookable.join(', ') || 'none'}`);

  if (problems.length) {
    console.log(`\nREFUSING — ${problems.length} problem(s):`);
    problems.forEach((p) => console.log(`  ✗ ${p}`));
    await mongoose.disconnect();
    process.exit(1);
  }
  if (!COMMIT) { console.log('\nDRY RUN — nothing written.'); await mongoose.disconnect(); return; }

  // ── Backup, then write in one transaction ───────────────────────────────────────────
  const dir = path.join(__dirname, '..', 'data', 'backups', `treatments-${stamp()}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'consultations.json'), JSON.stringify(await Consultation.find({}).lean(), null, 1));
  fs.writeFileSync(path.join(dir, 'categories.json'), JSON.stringify(await Category.find({}).lean(), null, 1));
  fs.writeFileSync(path.join(dir, 'servicetypes.json'), JSON.stringify(await ServiceType.find({}).lean(), null, 1));
  console.log(`\nbackup: ${path.relative(path.join(__dirname, '..'), dir)}`);

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const now = new Date();
      if (retire.length) {
        await Consultation.updateMany({ _id: { $in: retire.map((d) => d._id) } }, {
          $set: { inCatalog: false, catalogAddedAt: null, catalogAddedBy: null, isArchived: true, archivedAt: now, archivedReason: REASON },
        }, { session });
      }
      if (!typeDoc) {
        await ServiceType.create([{ name: TREATMENT_TYPE, slug: slugify(TREATMENT_TYPE), displayOrder: 0, isActive: true, description: 'The treatment menu in the app' }], { session });
      }
      for (const { c, doc } of catPlan) {
        const set = { name: c.name, type: TREATMENT_TYPE, displayOrder: c.order, icon: c.icon, isActive: true };
        if (doc) {
          await Category.updateOne({ _id: doc._id }, { $set: set }, { session });
        } else {
          // The menu key is the slug, as the app's bundled menu has it; suffixed only if taken.
          let slug = c.key;
          for (let n = 2; await Category.exists({ slug }).session(session); n += 1) slug = `${c.key}-${n}`;
          await Category.create([{ ...set, slug, description: '' }], { session });
        }
      }
      const fresh = rows.filter((r) => !r.existing).map((r) => r.doc);
      if (fresh.length) await Consultation.insertMany(fresh, { session, ordered: true });
      for (const { doc, existing } of rows.filter((r) => r.existing)) {
        await Consultation.updateOne({ _id: existing._id }, { $set: { ...pick(doc, COPY), inCatalog: true, isArchived: false, isActive: true } }, { session });
      }
    });
  } finally {
    await session.endSession();
  }

  for (const c of categories) {
    // eslint-disable-next-line no-await-in-loop
    const n = await Consultation.countDocuments({ category: c.name, isActive: true });
    // eslint-disable-next-line no-await-in-loop
    await Category.updateOne({ name: c.name }, { $set: { consultationCount: n } });
  }
  const live = await Consultation.countDocuments({ inCatalog: true, isArchived: { $ne: true }, isActive: true });
  console.log(`done — the app catalogue now holds ${live} rows (${rows.length} treatments + ${keep.length} consultation-flow rows)`);
  await mongoose.disconnect();
})().catch(async (e) => { console.error('FAILED:', e.message); await mongoose.disconnect().catch(() => {}); process.exit(1); });
