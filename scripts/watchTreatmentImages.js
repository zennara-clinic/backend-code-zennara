#!/usr/bin/env node
/**
 * Keeps each treatment's cover photo in step with the images dropped into
 * Backend/treatment_images_2026_sep/.
 *
 *   node scripts/watchTreatmentImages.js             watch and apply until stopped (Ctrl+C)
 *   node scripts/watchTreatmentImages.js --once      apply what is in the folder now, then exit
 *   node scripts/watchTreatmentImages.js --dry-run   show what would happen, change nothing
 *   node scripts/watchTreatmentImages.js --status    list which treatments have a photo
 *
 * A file is matched to one of the 64 treatments of the 2026-09 catalogue by its
 * name: "Hair Loss Treatment .png", "hair-loss-treatment.jpg" and "HAIR LOSS
 * TREATMENT" all land on Hair Loss Treatment. Case, spaces, punctuation, "&" vs
 * "and", a missing extension and a trailing " (2)" or " copy" don't matter, and
 * "Treatment" at the end is optional ("Botox" and "Botox Treatment" both work). A
 * near-miss spelling is accepted only when exactly one treatment is that close;
 * anything else is reported as NO MATCH with the nearest names, and nothing changes.
 *
 * Each image gets the same processing as a panel upload (POST /api/upload/media:
 * EXIF-rotated, fitted inside 1200x800, JPEG q85, zennara/consultations/ in S3; a
 * PNG keeps its transparency only if it really has some) and becomes the
 * treatment's `image`, the cover shown on cards, the detail header and search.
 * Applied files are remembered by content hash in data/treatment-image-sync/
 * state.json, so a restart uploads nothing twice and replacing a file with a new
 * picture applies it again. Every database change is appended, with the image it
 * replaced, to data/treatment-image-sync/changes.jsonl. Taking a file out of the
 * folder leaves the photo in place.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs');
const crypto = require('crypto');
const mongoose = require('mongoose');
const sharp = require('sharp');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { s3Client, S3_BUCKET } = require('../config/s3');

const ROOT = path.join(__dirname, '..');
const WATCH_DIR = process.env.TREATMENT_IMAGES_DIR || path.join(ROOT, 'treatment_images_2026_sep');
const SYNC_DIR = path.join(ROOT, 'data', 'treatment-image-sync');
const STATE_FILE = path.join(SYNC_DIR, 'state.json');
const CHANGES_FILE = path.join(SYNC_DIR, 'changes.jsonl');
const LOG_FILE = path.join(SYNC_DIR, 'watch.log');
const MARK = 'catalogue-2026-09';
const S3_FOLDER = 'zennara/consultations';
const SCAN_EVERY_MS = 3000;
const SETTLE_MS = 1500;          // a file must keep its size this long before it is read
const OLD_ENOUGH_MS = 10000;     // ...unless it was last written longer ago than this
const RETRY_MS = 60000;
const CATALOGUE_TTL_MS = 10 * 60000;
const READABLE = new Set(['png', 'jpeg', 'webp', 'avif', 'heif', 'tiff', 'gif']);

const argv = new Set(process.argv.slice(2));
const STATUS = argv.has('--status');
const DRY = argv.has('--dry-run');
const ONCE = DRY || STATUS || argv.has('--once');
const WRITES = !DRY && !STATUS;

fs.mkdirSync(SYNC_DIR, { recursive: true });

const clock = () => new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false });
function log(line) {
  const out = `[${clock()}] ${line}`;
  console.log(out);
  if (WRITES) {
    try { fs.appendFileSync(LOG_FILE, out + '\n'); } catch (_) { /* the console line is enough */ }
  }
}

let state = { files: {} };
try {
  state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  if (!state.files) state.files = {};
} catch (_) { /* first run */ }
function saveState() {
  if (!WRITES) return;
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

/* ---------- matching a file name to a treatment ---------- */

const EXT = /\.(png|jpe?g|webp|heic|heif|avif|tiff?|gif)$/i;
const SKIP = /^\.|\.(crdownload|download|part|partial|tmp|icloud)$|^(thumbs\.db|desktop\.ini)$/i;
const norm = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const withoutTreatment = (k) => k.replace(/ treatment$/, '');

function fileKey(file) {
  let base = file.trim();
  while (EXT.test(base)) base = base.replace(EXT, '').trim();
  base = base.replace(/\s*\(\d+\)$/, '').replace(/\s+copy(\s+\d+)?$/i, '').trim();
  return norm(base);
}

function distance(a, b) {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}
const similarity = (a, b) => 1 - distance(a, b) / Math.max(a.length, b.length, 1);

let coll = null;
let catalogue = { at: 0, rows: [], byId: new Map(), index: new Map() };

async function loadCatalogue() {
  const rows = await coll
    .find({ catalogAddedBy: MARK, isArchived: { $ne: true } })
    .project({ name: 1, slug: 1, image: 1 })
    .sort({ displayOrder: 1, name: 1 })
    .toArray();
  const index = new Map();
  const add = (key, row) => {
    if (!key) return;
    if (!index.has(key)) index.set(key, new Set());
    index.get(key).add(String(row._id));
  };
  for (const row of rows) {
    for (const key of [norm(row.name), norm(row.slug)]) {
      add(key, row);
      add(withoutTreatment(key), row);
    }
  }
  catalogue = { at: Date.now(), rows, byId: new Map(rows.map((r) => [String(r._id), r])), index };
}

function match(file) {
  const key = fileKey(file);
  if (!key) return { suggestions: [] };
  for (const k of [key, withoutTreatment(key)]) {
    const ids = catalogue.index.get(k);
    if (ids && ids.size === 1) return { row: catalogue.byId.get([...ids][0]), how: 'name' };
  }
  const best = new Map();
  for (const [k, ids] of catalogue.index) {
    if (ids.size !== 1) continue;
    const id = [...ids][0];
    const score = Math.max(similarity(key, k), similarity(withoutTreatment(key), k));
    if (score > (best.get(id) || 0)) best.set(id, score);
  }
  const ranked = [...best.entries()].sort((a, b) => b[1] - a[1]);
  const [first, second] = ranked;
  if (first && first[1] >= 0.86 && (!second || first[1] - second[1] >= 0.05)) {
    return { row: catalogue.byId.get(first[0]), how: 'close spelling' };
  }
  return { suggestions: ranked.slice(0, 2).map(([id]) => catalogue.byId.get(id).name) };
}

/* ---------- upload, the same way the panel does ---------- */

async function prepare(buffer) {
  const pipeline = sharp(buffer).rotate().resize(1200, 800, { fit: 'inside', withoutEnlargement: true });
  const { hasAlpha } = await sharp(buffer).metadata();
  const see = hasAlpha ? await sharp(buffer).stats() : null;
  if (hasAlpha && !see.isOpaque) {
    return { body: await pipeline.png({ compressionLevel: 8 }).toBuffer(), type: 'image/png', ext: '.png' };
  }
  return { body: await pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer(), type: 'image/jpeg', ext: '.jpg' };
}

async function upload(buffer) {
  const img = await prepare(buffer);
  const key = `${S3_FOLDER}/${crypto.randomBytes(16).toString('hex')}${img.ext}`;
  await s3Client.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: img.body, ContentType: img.type }));
  return `https://${S3_BUCKET}.s3.${process.env.AWS_S3_REGION}.amazonaws.com/${key}`;
}

/* ---------- one file ---------- */

const plan = { set: 0, noMatch: 0, unreadable: 0 };

async function handle(file, st) {
  const buffer = await fs.promises.readFile(path.join(WATCH_DIR, file));
  const hash = crypto.createHash('sha1').update(buffer).digest('hex');
  const known = state.files[file];
  const remember = (extra) => {
    state.files[file] = { hash, size: st.size, mtimeMs: st.mtimeMs, ...extra };
    saveState();
  };

  // Touched but not changed: nothing to do.
  if (known && known.hash === hash && (known.appliedTo || known.problem)) {
    const { retryAt, ...rest } = known;
    state.files[file] = { ...rest, size: st.size, mtimeMs: st.mtimeMs };
    saveState();
    return;
  }

  let meta = null;
  try { meta = await sharp(buffer).metadata(); } catch (_) { /* reported below */ }
  if (!meta || !READABLE.has(meta.format)) {
    plan.unreadable++;
    log(`✗ UNREADABLE "${file}": this isn't an image that can be read here. Save it as PNG or JPEG.`);
    return remember({ problem: 'unreadable' });
  }

  const found = match(file);
  if (!found.row) {
    plan.noMatch++;
    const near = found.suggestions && found.suggestions.length ? ` Closest: ${found.suggestions.join(', ')}.` : '';
    log(`✗ NO MATCH "${file}": no treatment has this name.${near} Rename the file to the treatment's name.`);
    return remember({ problem: 'no-match' });
  }

  const row = found.row;
  const ratio = meta.width / meta.height;
  const shape = Math.abs(ratio - 16 / 9) < 0.03 ? '' : ` (${meta.width}×${meta.height} is not 16:9; the app crops it to 16:10)`;
  const how = found.how === 'name' ? '' : ' (matched by close spelling)';
  plan.set++;
  if (!WRITES) {
    log(`would set ${row.name} ← "${file}"${how}${shape}`);
    return;
  }

  // The same picture was uploaded before (under this or another name): reuse it.
  const same = Object.values(state.files).find((f) => f.hash === hash && f.url);
  const url = same ? same.url : await upload(buffer);

  const current = await coll.findOne({ _id: row._id }, { projection: { image: 1 } });
  const previous = (current && current.image) || '';
  if (previous !== url) {
    await coll.updateOne({ _id: row._id }, { $set: { image: url, updatedAt: new Date() } });
    fs.appendFileSync(CHANGES_FILE, JSON.stringify({
      at: new Date().toISOString(), file, hash, slug: row.slug, name: row.name, previous, image: url,
    }) + '\n');
  }
  row.image = url;

  const earlier = Object.entries(state.files).find(([name, f]) => name !== file && f.appliedTo === row.slug);
  remember({ appliedTo: row.slug, url, at: new Date().toISOString() });
  const replaced = earlier ? `, replacing the photo from "${earlier[0]}"` : '';
  const have = catalogue.rows.filter((r) => r.image).length;
  log(`✓ APPLIED ${row.name} ← "${file}"${how}${shape}${replaced} · ${have} of ${catalogue.rows.length} treatments have a photo`);
}

/* ---------- the folder ---------- */

const seen = new Map();
let scanning = false;
let again = false;

async function scan() {
  if (scanning) { again = true; return; }
  scanning = true;
  try {
    if (Date.now() - catalogue.at > CATALOGUE_TTL_MS) await loadCatalogue();
    const entries = await fs.promises.readdir(WATCH_DIR, { withFileTypes: true });
    const files = [];
    for (const d of entries) {
      if (!d.isFile() || SKIP.test(d.name)) continue;
      try { files.push([d.name, await fs.promises.stat(path.join(WATCH_DIR, d.name))]); } catch (_) { /* gone meanwhile */ }
    }
    // Oldest first, so when two files name the same treatment the newer one wins.
    files.sort((a, b) => a[1].mtimeMs - b[1].mtimeMs);

    for (const [file, st] of files) {
      const known = state.files[file];
      const unchanged = known && known.size === st.size && known.mtimeMs === st.mtimeMs;
      if (unchanged && !known.retryAt) continue;
      if (unchanged && known.retryAt && Date.now() < known.retryAt) continue;

      const prev = seen.get(file);
      const steady = prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs && Date.now() - prev.at >= SETTLE_MS;
      if (!steady && Date.now() - st.mtimeMs < OLD_ENOUGH_MS) {
        if (!prev || prev.size !== st.size || prev.mtimeMs !== st.mtimeMs) seen.set(file, { size: st.size, mtimeMs: st.mtimeMs, at: Date.now() });
        continue;
      }
      seen.delete(file);

      try {
        await handle(file, st);
      } catch (err) {
        log(`✗ FAILED "${file}": ${err.message}. Trying again in a minute.`);
        state.files[file] = { ...(state.files[file] || {}), size: st.size, mtimeMs: st.mtimeMs, retryAt: Date.now() + RETRY_MS };
        saveState();
      }
    }
  } catch (err) {
    log(`✗ FAILED reading the folder: ${err.message}`);
  } finally {
    scanning = false;
    if (again) { again = false; setImmediate(scan); }
  }
}

function printStatus() {
  const missing = catalogue.rows.filter((r) => !r.image);
  console.log(`${catalogue.rows.length - missing.length} of ${catalogue.rows.length} treatments have a photo.`);
  if (missing.length) console.log(`Still without a photo (${missing.length}):\n  ${missing.map((r) => r.name).join('\n  ')}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!fs.existsSync(WATCH_DIR)) {
    log(`✗ FATAL the folder ${WATCH_DIR} doesn't exist`);
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGODB_DB || 'test' });
  coll = mongoose.connection.db.collection('consultations');
  await loadCatalogue();

  if (STATUS) {
    printStatus();
    await mongoose.disconnect();
    return;
  }

  const have = catalogue.rows.filter((r) => r.image).length;
  log(`${DRY ? 'Dry run of' : ONCE ? 'One pass over' : 'Watching'} ${path.relative(ROOT, WATCH_DIR)}/ · ${have} of ${catalogue.rows.length} treatments have a photo`);
  await scan();

  if (ONCE) {
    for (let i = 0; i < 12 && seen.size; i++) { await sleep(SETTLE_MS); await scan(); }
    if (DRY) log(`Dry run: ${plan.set} would be set, ${plan.noMatch} without a match, ${plan.unreadable} unreadable. Nothing was changed.`);
    else log(`Done: ${catalogue.rows.filter((r) => r.image).length} of ${catalogue.rows.length} treatments have a photo.`);
    await mongoose.disconnect();
    return;
  }

  let kick = null;
  fs.watch(WATCH_DIR, () => {
    clearTimeout(kick);
    kick = setTimeout(scan, 400);
  });
  setInterval(scan, SCAN_EVERY_MS);

  const stop = async (signal) => {
    log(`■ STOPPED watching (${signal})`);
    try { await mongoose.disconnect(); } catch (_) { /* exiting anyway */ }
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

main().catch(async (err) => {
  log(`✗ FATAL ${err.message}`);
  try { await mongoose.disconnect(); } catch (_) { /* exiting anyway */ }
  process.exit(1);
});
