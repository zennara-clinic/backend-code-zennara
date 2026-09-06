/**
 * One-time bootstrap of the Commerce catalogue from the pharmacy's sheets.
 *
 *   node scripts/importAppStockSheets.js --template "<AppStock_Import_Template>.xlsx" --classes "<JH_Retail_Rx_vs_OTC>.xlsx" [--apply]
 *
 * Dry run by default: prints exactly what would change. --apply writes it.
 * Rules (the same ones the panel's Import button uses, plus one bootstrap step):
 *   • rows match products that already exist here (code, then exact name) — nothing is created
 *   • OTC rows → in the Commerce catalogue, live in the app when priced
 *   • Rx rows  → flagged prescription, off the app
 *   • template rows → stock, prices, GST, re-order / target, pack, vendor, status
 *   • bootstrap: products already live in the app today stay in the catalogue
 *     (unless the sheet says Rx), so nothing a guest can see today disappears
 * Nothing here calls Zenoti.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const XLSX = require('xlsx');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : d; };
const sheetsOf = (f) => { const wb = XLSX.readFile(f); return wb.SheetNames.map((name) => ({ name, rows: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' }) })); };

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const Product = require('../models/Product');
  const { parseAppStockWorkbook } = require('../utils/appStockTemplate');
  const ctrl = require('../controllers/adminProductController');
  const apply = !!arg('apply', false);

  const sheets = [];
  for (const f of [arg('template'), arg('classes')].filter((x) => x && x !== true)) sheets.push(...parseAppStockWorkbook(sheetsOf(f)));
  if (!sheets.length) { console.error('Pass --template and/or --classes with the .xlsx files.'); process.exit(1); }
  for (const s of sheets) console.log(`sheet ${s.sheetName} (${s.kind}${s.classification ? ' · ' + s.classification : ''}): ${s.rows.length} rows`);

  const { plan, unmatched } = await ctrl.matchTemplateRows(sheets);
  console.log(`\nmatched ${plan.size} products · unmatched ${unmatched.length}${unmatched.length ? ' → ' + unmatched.slice(0, 5).join(' | ') : ''}`);

  const before = { live: await Product.countDocuments({ isActive: true }), app: await Product.countDocuments({ isAppProduct: true }), rx: await Product.countDocuments({ isRx: true }) };
  const rxIds = new Set([...plan.values()].filter((e) => e.rx).map((e) => String(e.product._id)));
  const otcIds = new Set([...plan.values()].filter((e) => e.otc).map((e) => String(e.product._id)));
  const liveNow = await Product.find({ isActive: true }).select('_id name').lean();
  const keep = liveNow.filter((p) => !rxIds.has(String(p._id)) && !otcIds.has(String(p._id)));
  const goingOff = liveNow.filter((p) => rxIds.has(String(p._id)));
  const goingOn = [...plan.values()].filter((e) => e.otc && !e.product.isActive && (Number(e.product.price) > 0 || (e.template && e.template.price) || e.otc.mrp));

  console.log(`\nAPP TODAY: ${before.live} live · in catalogue ${before.app} · Rx ${before.rx}`);
  console.log(`will publish (OTC, not live yet): ${goingOn.length}`);
  console.log(`will take OFF the app (sheet says Rx): ${goingOff.length}${goingOff.length ? ' → ' + goingOff.slice(0, 8).map((p) => p.name).join(' | ') : ''}`);
  console.log(`live today but not in either sheet (kept as-is): ${keep.length}`);

  if (!apply) { console.log('\nDRY RUN — nothing written. Re-run with --apply.'); await mongoose.disconnect(); return; }

  const stats = await ctrl.applyAppStockPlan(plan, { adminName: 'bootstrap' });
  // Bootstrap: what is live today stays in the catalogue unless the sheet said Rx.
  const kept = await Product.updateMany({ _id: { $in: keep.map((p) => p._id) } }, { $set: { isAppProduct: true } });
  const after = { live: await Product.countDocuments({ isActive: true }), app: await Product.countDocuments({ isAppProduct: true }), rx: await Product.countDocuments({ isRx: true }), noPhoto: await Product.countDocuments({ isActive: true, isAppProduct: true, $or: [{ image: null }, { image: '' }] }) };
  console.log(`\nAPPLIED: ${JSON.stringify(stats)} · kept live ${kept.modifiedCount}`);
  console.log(`APP NOW: ${after.live} live · in catalogue ${after.app} · Rx ${after.rx} · live without a photo ${after.noPhoto}`);
  await mongoose.disconnect();
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
