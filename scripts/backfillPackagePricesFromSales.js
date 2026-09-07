/**
 * Fill package prices from real sales.
 *
 * Zenoti's API publishes no package price and no package contents — verified
 * across every field it returns (53 paths over 200 packages): no price, and
 * `catalog_info`, `centers` and `benefits` are always null. The package detail
 * endpoint is refused to this key. So the only truthful source for what a
 * package costs is what a guest was actually charged for it.
 *
 *   node --env-file=.env scripts/backfillPackagePricesFromSales.js [--apply]
 *
 * Takes the highest amount actually charged on an assignment (the list price;
 * lower ones are discounts) and writes it only where the package has no price.
 * Never overwrites a price a person set in the panel.
 */
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const Package = require('../models/Package');
  const PackageAssignment = require('../models/PackageAssignment');
  const apply = process.argv.includes('--apply');

  const sold = await PackageAssignment.aggregate([
    { $match: { packageId: { $ne: null } } },
    { $group: {
      _id: '$packageId',
      sales: { $sum: 1 },
      listPrice: { $max: { $ifNull: ['$pricing.originalAmount', '$pricing.finalAmount'] } },
      lastPaid: { $max: '$pricing.finalAmount' },
    } },
  ]);

  const plan = [];
  for (const row of sold) {
    const price = Number(row.listPrice) || Number(row.lastPaid) || 0;
    if (price <= 0) continue;
    const pkg = await Package.findById(row._id).select('name price').lean();
    if (!pkg || Number(pkg.price) > 0) continue;
    plan.push({ _id: pkg._id, name: pkg.name, price, sales: row.sales });
  }

  console.log(`packages sold at least once: ${sold.length}`);
  console.log(`unpriced packages a real sale can price: ${plan.length}`);
  plan.forEach((p) => console.log(`  · ${p.name} → ₹${Math.round(p.price)} (from ${p.sales} sale${p.sales === 1 ? '' : 's'})`));

  const stillBlank = await Package.countDocuments({ origin: 'zenoti', $or: [{ price: 0 }, { price: null }] });
  console.log(`\nunpriced Zenoti packages in total: ${stillBlank} — the rest have never been sold, so nothing knows their price but the clinic.`);

  if (!apply) { console.log('\nDRY RUN — re-run with --apply'); await mongoose.disconnect(); return; }
  if (plan.length) {
    await Package.bulkWrite(plan.map((p) => ({
      updateOne: { filter: { _id: p._id }, update: { $set: { price: Math.round(p.price * 100) / 100, priceSource: 'sale' } } },
    })));
  }
  console.log(`\nAPPLIED to ${plan.length} package(s). Unpriced now: ${await Package.countDocuments({ origin: 'zenoti', $or: [{ price: 0 }, { price: null }] })}`);
  await mongoose.disconnect();
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
