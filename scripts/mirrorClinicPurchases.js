/**
 * Fold every clinic purchase already fetched from Zenoti into package
 * assignments and orders — no Zenoti calls, database only.
 *
 *   node scripts/mirrorClinicPurchases.js
 *
 * The purchase mirror normally runs as each guest's history is refreshed. The
 * histories of ~7,000 guests were fetched before that mirror existed, so this
 * walks the stored histories once and applies it to all of them.
 */
require('dotenv').config();
const mongoose = require('mongoose');
(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const ZG = require('../models/ZenotiGuestData'); const User = require('../models/User');
  const { mirrorGuestPackages, mirrorGuestOrders } = require('../services/zenotiAssignmentMirror');
  const tot = { guests: 0, pk: { seen: 0, created: 0, updated: 0, failed: 0 }, or: { seen: 0, created: 0, skippedNoProduct: 0, failed: 0 } };
  const cursor = ZG.find({ $or: [{ 'packages.0': { $exists: true } }, { 'orders.0': { $exists: true } }] }).select('userId packages orders').lean().cursor();
  const started = Date.now();
  for await (const g of cursor) {
    const user = await User.findById(g.userId).select('fullName email phone patientId memberType').lean();
    if (!user) continue;
    tot.guests += 1;
    const p = await mirrorGuestPackages(user, g.packages || []);
    const o = await mirrorGuestOrders(user, g.orders || []);
    for (const k of Object.keys(tot.pk)) tot.pk[k] += p[k] || 0;
    for (const k of Object.keys(tot.or)) tot.or[k] += o[k] || 0;
    if (tot.guests % 500 === 0) console.log(`  ${tot.guests} guests… ${Math.round((Date.now() - started) / 1000)}s`);
  }
  console.log(JSON.stringify(tot));
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
