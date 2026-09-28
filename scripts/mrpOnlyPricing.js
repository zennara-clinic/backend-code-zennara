/**
 * One price per product: the MRP, every tax included (store policy, 2026-09-28).
 *
 * Two steps; nothing is written without --apply.
 *
 *   1. mrp := price wherever the two differ. `price` is what the app has been
 *      listing and charging, so it is the MRP from now on; the old `mrp` is
 *      printed and kept in the backup file. Safe at any time.
 *
 *   2. gstPercentage := 18 where it is 0 or missing. The 2026-09-27 catalogue
 *      load wrote 0 only because checkout used to ADD a product's rate on top
 *      of its price; the rate is now information only and blank means 18.
 *      NOT safe while the old backend is live — it would charge 18% more on
 *      every order. So step 2 runs only with --gst, and refuses unless the
 *      live API has stopped sending `gstPercentage` (the same release hides
 *      it). --skip-live-check overrides that, for use on the server right
 *      after the deploy when the check cannot reach the API.
 *
 * Usage (from Backend/):
 *   node scripts/mrpOnlyPricing.js                    # dry run, both steps
 *   node scripts/mrpOnlyPricing.js --apply            # step 1
 *   node scripts/mrpOnlyPricing.js --apply --gst      # steps 1 and 2 — after the deploy
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const args = new Set(process.argv.slice(2));
const APPLY = args.has('--apply');
const GST = args.has('--gst');
const SKIP_LIVE_CHECK = args.has('--skip-live-check');
const LIVE_API = (process.env.LIVE_API_BASE || 'https://api.zennara.in').replace(/\/+$/, '');
const DEFAULT_GST = 18;

/** true = the live API runs the MRP-only release (it no longer sends the rate). */
async function liveApiIsMrpOnly() {
  const res = await fetch(`${LIVE_API}/api/products?limit=3`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${LIVE_API}/api/products answered ${res.status}`);
  const body = await res.json();
  const rows = Array.isArray(body.data) ? body.data : [];
  if (!rows.length) throw new Error('the live API returned no products to check');
  return rows.every((p) => !Object.prototype.hasOwnProperty.call(p, 'gstPercentage'));
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const products = mongoose.connection.db.collection('products');
  const rows = await products.find({}, { projection: { name: 1, price: 1, mrp: 1, gstPercentage: 1 } }).toArray();

  const mrpFixes = rows.filter((p) => Number.isFinite(Number(p.price)) && Number(p.mrp) !== Number(p.price));
  const gstFixes = rows.filter((p) => !(Number(p.gstPercentage) > 0));

  console.log(`${rows.length} products.`);
  console.log(`\nStep 1 — MRP becomes the listed price on ${mrpFixes.length}:`);
  for (const p of mrpFixes) console.log(`  ${p.name}: price ₹${p.price} stays; mrp ${p.mrp ?? '—'} → ${p.price}`);
  console.log(`\nStep 2 — GST ${DEFAULT_GST}% (information only) on ${gstFixes.length} that hold 0 or nothing.`);

  let gstAllowed = false;
  if (GST) {
    if (SKIP_LIVE_CHECK) gstAllowed = true;
    else {
      try {
        gstAllowed = await liveApiIsMrpOnly();
        if (!gstAllowed) console.log(`\n  REFUSED: ${LIVE_API} still sends gstPercentage — the backend that stops adding GST is not live yet. Deploy it, then run this again.`);
      } catch (err) {
        console.log(`\n  REFUSED: could not check the live API (${err.message}). On the server, after the deploy, add --skip-live-check.`);
      }
    }
  } else if (gstFixes.length) {
    console.log('  (not run: add --gst once the new backend is live)');
  }

  if (!APPLY) {
    console.log('\nDry run — nothing written. Add --apply to write.');
    await mongoose.disconnect();
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(__dirname, '..', 'data', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `mrp-only-pricing-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify({ at: new Date(), mrpFixes, gstFixes: gstAllowed ? gstFixes : [] }, null, 2));
  console.log(`\nBackup of every row about to change: ${file}`);

  const ops = mrpFixes.map((p) => ({ updateOne: { filter: { _id: p._id }, update: { $set: { mrp: Number(p.price) } } } }));
  if (gstAllowed) {
    for (const p of gstFixes) ops.push({ updateOne: { filter: { _id: p._id }, update: { $set: { gstPercentage: DEFAULT_GST } } } });
  }
  if (ops.length) {
    const r = await products.bulkWrite(ops, { ordered: false });
    console.log(`Written: ${r.modifiedCount} updates (${mrpFixes.length} MRP${gstAllowed ? `, ${gstFixes.length} GST` : ''}).`);
  } else {
    console.log('Nothing to write.');
  }
  await mongoose.disconnect();
})().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
