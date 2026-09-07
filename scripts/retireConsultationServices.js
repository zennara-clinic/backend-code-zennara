/**
 * Take the consultation rows out of the treatment menu.
 *
 * A consultation is booked through its own flow — pick a dermatologist, a
 * clinic, a slot — not chosen off the treatment listing. Six rows sat in the
 * app catalogue under a "Consultation" category and duplicated that flow.
 *
 * They are NOT all the same thing, so they are not all treated the same:
 *
 *   KEEP  senior-dermatologist-consultation
 *   KEEP  dermatologist-consultation
 *         These two ARE the consultation flow. review.tsx fetches the app
 *         catalogue and looks them up by slug to price the booking, and
 *         utils/consultationPricing.js maps each doctor tier onto one. Remove
 *         them and consultation checkout has nothing to charge for. They stay
 *         published; the treatment listings already hide them by name.
 *
 *   RETIRE  General / Follow-Up / Other / Dr. Rickson Consultations
 *         Redundant with the flow, zero bookings, zero package references.
 *         Archived rather than deleted, like every other superseded service.
 *
 *   node scripts/retireConsultationServices.js            # dry run
 *   node scripts/retireConsultationServices.js --commit
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Consultation = require('../models/Consultation');
const Category = require('../models/Category');
const ServiceType = require('../models/ServiceType');
const Booking = require('../models/Booking');
const PackageAssignment = require('../models/PackageAssignment');

const COMMIT = process.argv.includes('--commit');
/** The two rows the consultation flow resolves by slug. Never retire these. */
const KEEP_SLUGS = ['senior-dermatologist-consultation', 'dermatologist-consultation'];

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGODB_DB || 'test' });
  console.log(COMMIT ? '*** COMMIT ***\n' : '--- DRY RUN ---\n');

  const published = await Consultation.find({
    isArchived: { $ne: true }, inCatalog: true, category: 'Consultation',
  }).select('id slug name price').lean();

  const keep = published.filter((c) => KEEP_SLUGS.includes(c.slug));
  const retire = published.filter((c) => !KEEP_SLUGS.includes(c.slug));

  console.log('KEEP — the consultation flow depends on these:');
  keep.forEach((c) => console.log(`  · ${c.name}  (slug ${c.slug}, ₹${c.price})`));
  if (keep.length < 2) {
    console.log(`\n  REFUSING: expected both tier rows, found ${keep.length}.`);
    console.log('  Retiring the rest would leave consultation checkout with nothing to charge.');
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log('\nRETIRE — redundant with that flow:');
  let blocked = 0;
  for (const c of retire) {
    const bookings = await Booking.countDocuments({ consultationId: c._id });
    const packages = await PackageAssignment.countDocuments({ 'packageDetails.services.serviceId': c.id });
    const safe = bookings === 0 && packages === 0;
    if (!safe) blocked += 1;
    console.log(`  ${safe ? '·' : '✗'} ${String(c.name).padEnd(34)} bookings=${bookings} packages=${packages}${safe ? '' : '  ← kept, it has history'}`);
    if (COMMIT && safe) {
      await Consultation.updateOne({ _id: c._id }, {
        $set: {
          inCatalog: false, catalogAddedAt: null, catalogAddedBy: null,
          isArchived: true, archivedAt: new Date(),
          archivedReason: 'Consultations are booked through the consultation flow, not the treatment menu',
        },
      });
    }
  }

  if (COMMIT) {
    // The category and type exist only for these rows; with the two tier
    // entries left they are infrastructure, not a menu section, so they come
    // out of the taxonomy the panel and app browse.
    await Category.deleteMany({ name: 'Consultation' });
    await ServiceType.deleteMany({ name: 'Consultations' });
    console.log('\n  removed the "Consultation" category and "Consultations" type from the browsable taxonomy');
    const left = await Consultation.countDocuments({ isArchived: { $ne: true }, inCatalog: true });
    console.log(`  app catalogue is now ${left} services`);
  }
  if (blocked) console.log(`\n  ${blocked} kept because they carry history.`);
  await mongoose.disconnect();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
