/**
 * Put product photographs on our own storage and attach them to the products.
 *
 *   node scripts/importProductImages.js prepare --manifest <manifest.json> --out <dir>
 *   node scripts/importProductImages.js upload  --manifest <manifest.json> --out <dir> --ocr <final-ocr.json> [--apply] [--force]
 *
 * THE GATE. A photograph is published only if it passed all three checks, and
 * the script refuses anything that did not — it never trusts the file name:
 *
 *   1. text read from the ORIGINAL (on-device OCR) does not name another shop
 *   2. a person-grade visual review accepted it: a plain photograph of the
 *      named product — no shop name or logo, no retailer's price sticker, no
 *      designed graphic, no watermark
 *   3. text read from the FINAL file — the exact bytes that would be uploaded
 *      — does not name another shop either
 *
 * The manifest carries checks 1 and 2 together with each file's SHA-256, so a
 * file swapped after it was reviewed fails here. `prepare` writes the final
 * files (resized, flattened on white, metadata removed); check 3 is run over
 * that folder and handed to `upload` as --ocr.
 *
 * `upload` is a dry run unless --apply. It never replaces a photograph a
 * product already has unless --force. Files go to products/<slug>/ under a
 * content-hashed name, so they can be cached for good.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const mongoose = require('mongoose');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : d; };
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Any spelling of the other shop's name, spaced or hyphenated, as OCR may return it. */
const OTHER_SHOP = /a\s*g\s*e\s*[-\s]?\s*l\s*e\s*s\s*s|agel[e3]ss|age1ess|ageiess|geless\b/i;
const MAX_PER_PRODUCT = 4;
const LONG_EDGE = 1600;

/** Checks 1 and 2, and that the file is the one that was checked. Returns the reason it fails, or null. */
function refuse(entry, buf) {
  if (entry.ocr !== 'clean') return 'original names another shop (OCR)';
  if (entry.review !== 'accept') return `visual review: ${entry.reviewReason || 'rejected'}`;
  if (!entry.sha256 || sha256(buf) !== entry.sha256) return 'file changed since it was reviewed';
  return null;
}

const finalName = (slug, n) => path.join(slug, `${n}.jpg`);

async function prepare(manifest, out) {
  let written = 0; let refused = 0;
  for (const product of manifest) {
    let n = 0;
    for (const entry of product.images) {
      if (n >= MAX_PER_PRODUCT) break;
      const buf = fs.readFileSync(entry.file);
      const why = refuse(entry, buf);
      if (why) { refused += 1; continue; }
      n += 1;
      const target = path.join(out, finalName(product.slug, n));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // No .withMetadata(): EXIF, XMP and any embedded author or copyright note are dropped.
      await sharp(buf).rotate().flatten({ background: '#ffffff' })
        .resize(LONG_EDGE, LONG_EDGE, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 86, progressive: true, mozjpeg: true })
        .toFile(target);
      written += 1;
    }
  }
  console.log(`prepared ${written} files in ${out} · refused ${refused}`);
}

async function upload(manifest, out, ocrFile, { apply, force }) {
  if (!ocrFile || !fs.existsSync(ocrFile)) { console.error('Pass --ocr <json>: the text read from the prepared files (check 3).'); process.exit(1); }
  const finalText = JSON.parse(fs.readFileSync(ocrFile, 'utf8'));
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const { s3Client, S3_BUCKET } = require('../config/s3');
  await mongoose.connect(process.env.MONGODB_URI);
  const Product = require('../models/Product');

  const stats = { products: 0, photos: 0, noProduct: [], hasPhoto: 0, refused: [], noneLeft: [] };
  for (const item of manifest) {
    const product = await Product.findOne({ slug: item.slug }).select('_id name image images');
    if (!product) { stats.noProduct.push(item.slug); continue; }
    if (product.image && !force) { stats.hasPhoto += 1; continue; }

    const urls = [];
    let n = 0;
    for (const entry of item.images) {
      if (n >= MAX_PER_PRODUCT) break;
      const why = refuse(entry, fs.readFileSync(entry.file));
      if (why) continue;
      n += 1;
      const rel = finalName(item.slug, n);
      const file = path.join(out, rel);
      if (!fs.existsSync(file)) { stats.refused.push(`${rel}: not prepared`); continue; }
      // Check 3: the bytes about to be published.
      const body = fs.readFileSync(file);
      const read = finalText[rel];
      if (!read || read.error || typeof read.text !== 'string') { stats.refused.push(`${rel}: final file was not read`); continue; }
      if (read.sha256 !== sha256(body)) { stats.refused.push(`${rel}: final file changed since it was read`); continue; }
      if (OTHER_SHOP.test(read.text)) { stats.refused.push(`${rel}: final file names another shop`); continue; }
      const key = `products/${item.slug}/${n}-${sha256(body).slice(0, 12)}.jpg`;
      if (apply) {
        await s3Client.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: body, ContentType: 'image/jpeg', CacheControl: 'public, max-age=31536000, immutable' }));
      }
      urls.push(`https://${S3_BUCKET}.s3.${process.env.AWS_S3_REGION}.amazonaws.com/${key}`);
    }
    if (!urls.length) { stats.noneLeft.push(item.slug); continue; }
    if (apply) await Product.updateOne({ _id: product._id }, { $set: { image: urls[0], images: urls } });
    stats.products += 1; stats.photos += urls.length;
  }

  console.log(`${apply ? 'UPLOADED' : 'WOULD UPLOAD'} ${stats.photos} photographs for ${stats.products} products`);
  console.log(`  already had a photograph (left alone): ${stats.hasPhoto}`);
  console.log(`  no photograph passed the gate: ${stats.noneLeft.length}${stats.noneLeft.length ? ` → ${stats.noneLeft.join(', ')}` : ''}`);
  if (stats.refused.length) console.log(`  refused at the last check: ${stats.refused.length}\n    ${stats.refused.join('\n    ')}`);
  if (stats.noProduct.length) console.log(`  no such product: ${stats.noProduct.join(', ')}`);
  if (apply) console.log(`  products with a photograph now: ${await Product.countDocuments({ image: { $nin: ['', null] } })} of ${await Product.countDocuments({})}`);
  else console.log('DRY RUN — nothing uploaded, nothing written. Re-run with --apply.');
  await mongoose.disconnect();
}

if (require.main === module) (async () => {
  const mode = process.argv[2];
  const manifestFile = arg('manifest');
  const out = arg('out');
  if (!['prepare', 'upload'].includes(mode) || !manifestFile || manifestFile === true || !out || out === true) {
    console.error('Usage: importProductImages.js prepare|upload --manifest <json> --out <dir> [--ocr <json>] [--apply] [--force]');
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (mode === 'prepare') await prepare(manifest, out);
  else await upload(manifest, out, arg('ocr'), { apply: !!arg('apply', false), force: !!arg('force', false) });
})().catch(async (e) => { console.error('FAILED', e); await mongoose.disconnect().catch(() => {}); process.exit(1); });

module.exports = { OTHER_SHOP, refuse };
