/**
 * Fill a package's contents and price from any real sale of it.
 *
 * Zenoti's catalogue publishes neither, so the only source is a purchase: the
 * guest's copy of a package DOES list its services and what was paid. The
 * existing backfill matched sales by packageId alone; older assignments were
 * never linked, so their evidence was invisible. Matching by name as well
 * recovers those.
 *
 *   node scripts/fillPackagesFromAnySale.js            # dry run
 *   node scripts/fillPackagesFromAnySale.js --commit
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Package = require('../models/Package');
const PackageAssignment = require('../models/PackageAssignment');

const COMMIT = process.argv.includes('--commit');
const key = (v) => String(v || '').trim().toLowerCase();

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGODB_DB || 'test' });
  console.log(COMMIT ? '*** COMMIT ***\n' : '--- DRY RUN ---\n');

  const sales = await PackageAssignment.find({})
    .select('packageId packageDetails').sort({ createdAt: -1 }).lean();
  const byId = new Map(); const byName = new Map();
  for (const s of sales) {
    const svc = s.packageDetails?.services || [];
    const price = Number(s.packageDetails?.packagePrice) || 0;
    if (!svc.length && !price) continue;
    const id = String(s.packageId || '');
    // Prefer a sale that carries BOTH.
    const better = (prev) => !prev || ((svc.length && !prev.svc.length) || (price && !prev.price));
    if (id && better(byId.get(id))) byId.set(id, { svc, price });
    const n = key(s.packageDetails?.packageName);
    if (n && better(byName.get(n))) byName.set(n, { svc, price });
  }

  const gaps = await Package.find({
    $or: [{ services: { $size: 0 } }, { services: { $exists: false } }, { price: null }, { price: 0 }],
  });
  let svcFilled = 0; let priceFilled = 0;

  for (const p of gaps) {
    const ev = byId.get(String(p._id)) || byName.get(key(p.name));
    if (!ev) continue;
    const set = {};
    if (!(p.services || []).length && ev.svc.length) {
      set.services = ev.svc.map((s) => ({
        serviceId: s.serviceId, serviceName: s.serviceName,
        servicePrice: s.servicePrice ?? 0, sessions: Math.max(1, Number(s.sessions) || 1),
      }));
      set.contentsKnown = true;
      svcFilled += 1;
    }
    if (!(Number(p.price) > 0) && ev.price > 0) {
      set.price = ev.price;
      if (!(Number(p.originalPrice) > 0)) set.originalPrice = ev.price;
      priceFilled += 1;
    }
    if (!Object.keys(set).length) continue;
    console.log(`  ${String(p.name).slice(0, 42).padEnd(44)} ${set.services ? `${set.services.length} services` : ''} ${set.price ? `Rs${set.price}` : ''}`);
    if (COMMIT) await Package.updateOne({ _id: p._id }, { $set: set });
  }

  console.log(`\ncontents filled: ${svcFilled}   prices filled: ${priceFilled}`);
  if (COMMIT) {
    const noSvc = await Package.countDocuments({ $or: [{ services: { $size: 0 } }, { services: { $exists: false } }] });
    const noPrice = await Package.countDocuments({ $or: [{ price: null }, { price: 0 }] });
    console.log(`remaining without contents: ${noSvc}   without price: ${noPrice}`);
  }
  await mongoose.disconnect();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
