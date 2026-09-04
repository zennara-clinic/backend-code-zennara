/**
 * Move Zenoti links from mirror-made hidden shells onto the clinic's real records.
 *
 *   node scripts/reconcileZenotiLinks.js          # preview
 *   node scripts/reconcileZenotiLinks.js --apply
 *
 * The first catalogue run matched by exact name only, so Zenoti's "Laser Hair
 * Removal" became a hidden shell while the clinic's own "Laser Hair Removal
 * (LHR)" stayed unlinked. For every ACTIVE record without a Zenoti id, find a
 * mirror-made shell whose normalised name matches, copy the Zenoti id (and
 * duration / Zenoti attributes) onto the real record, and delete the shell —
 * only if nothing references the shell. Ambiguous names are reported, not
 * guessed.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { findByName } = require('../utils/nameMatch');
const APPLY = process.argv.includes('--apply');

async function reconcile({ Model, label, idField, shellFilter, refCheck, copy }) {
  const active = await Model.find({ isActive: true, [idField]: { $in: [null, ''] } }).lean();
  const shells = await Model.find({ isActive: false, [idField]: { $type: 'string' }, ...shellFilter }).lean();
  const out = { label, active: active.length, shells: shells.length, linked: 0, deletedShells: 0, ambiguous: [], referenced: [] };
  for (const rec of active) {
    const shell = findByName(shells, rec.name);
    if (!shell) {
      // findByName returns null for 0 OR >1 hits; distinguish for the report.
      const { normalizeName } = require('../utils/nameMatch');
      const n = shells.filter((s) => normalizeName(s.name) === normalizeName(rec.name)).length;
      if (n > 1) out.ambiguous.push(rec.name);
      continue;
    }
    const refs = refCheck ? await refCheck(shell) : 0;
    console.log(`  ${rec.name}  ←  ${shell.name}  [${shell[idField]}]${refs ? `  (shell referenced ${refs}×, kept)` : ''}`);
    if (!APPLY) continue;
    const set = { [idField]: shell[idField], ...copy(shell) };
    await Model.updateOne({ _id: rec._id }, { $set: set });
    out.linked += 1;
    if (!refs) {
      await Model.deleteOne({ _id: shell._id });
      out.deletedShells += 1;
    } else {
      // Two records cannot share a Zenoti id; the shell loses it.
      await Model.updateOne({ _id: shell._id }, { $unset: { [idField]: '' } });
      out.referenced.push(shell.name);
    }
    shells.splice(shells.indexOf(shell), 1);
  }
  return out;
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const Consultation = require('../models/Consultation');
  const Package = require('../models/Package');
  const Product = require('../models/Product');
  const Booking = require('../models/Booking');
  const PackageAssignment = require('../models/PackageAssignment');
  const ProductOrder = require('../models/ProductOrder');

  console.log(APPLY ? 'APPLYING' : 'PREVIEW', '\n== services ==');
  const s = await reconcile({
    Model: Consultation, label: 'services', idField: 'zenotiServiceId',
    shellFilter: { summary: /synced from Zenoti|is available at/i },
    refCheck: (shell) => Booking.countDocuments({ consultationId: shell._id }),
    copy: (shell) => ({ ...(shell.duration_minutes ? { duration_minutes: shell.duration_minutes } : {}) }),
  });
  console.log('== packages ==');
  const p = await reconcile({
    Model: Package, label: 'packages', idField: 'zenotiPackageId',
    shellFilter: { description: /synced from Zenoti|first seen as a clinic purchase/i },
    refCheck: (shell) => PackageAssignment.countDocuments({ packageId: shell._id }),
    copy: (shell) => ({ ...(shell.zenotiSeriesTerms ? { zenotiSeriesTerms: shell.zenotiSeriesTerms } : {}) }),
  });
  console.log('== products ==');
  const r = await reconcile({
    Model: Product, label: 'products', idField: 'zenotiProductId',
    shellFilter: { description: /Synced from Zenoti/i },
    refCheck: (shell) => ProductOrder.countDocuments({ 'items.productId': shell._id }),
    copy: (shell) => ({
      ...(shell.sku ? { sku: shell.sku } : {}), ...(shell.brand ? { brand: shell.brand } : {}),
      ...(shell.productCategory ? { productCategory: shell.productCategory } : {}),
      ...(shell.productSubCategory ? { productSubCategory: shell.productSubCategory } : {}),
      ...(shell.mrp != null ? { mrp: shell.mrp } : {}), ...(shell.packSize ? { packSize: shell.packSize } : {}),
      ...(shell.hsn ? { hsn: shell.hsn } : {}), ...(shell.isRetail != null ? { isRetail: shell.isRetail } : {}),
      productType: shell.productType || null,
    }),
  });
  for (const o of [s, p, r]) console.log(`${o.label}: ${o.active} active unlinked, ${o.shells} shells; linked ${o.linked}, shells removed ${o.deletedShells}${o.ambiguous.length ? `; ambiguous: ${o.ambiguous.join(', ')}` : ''}${o.referenced.length ? `; shells kept (referenced): ${o.referenced.join(', ')}` : ''}`);
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
