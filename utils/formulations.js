/**
 * Formulations — the buckets the app groups products under.
 *
 * The catalogue itself is the source of truth for these names: they arrive on
 * the OTC sheet and on each product's page, and the panel has no separate
 * "Formulations" screen any more. So a product may carry any formulation;
 * saving it REGISTERS the name in the Formulation collection (case- and
 * spacing-insensitively, snapping to a spelling already registered) rather
 * than refusing the save. Refusing was how every product edit — a photo, a
 * price, a toggle — started failing once the catalogue was rebuilt from the
 * sheet without seeding this collection.
 */
const Formulation = require('../models/Formulation');
const { tidyName, taxonomyKey } = require('./taxonomy');

/**
 * Make sure `name` is a registered formulation and return the spelling to
 * store on the product. Blank names come back as null and register nothing.
 */
async function registerFormulation(name) {
  const tidy = tidyName(name);
  if (!tidy) return null;
  const key = taxonomyKey(tidy);
  const rows = await Formulation.find({}).select('name').lean();
  const hit = rows.find((r) => taxonomyKey(r.name) === key);
  if (hit) return hit.name;
  try {
    await Formulation.create({ name: tidy, isActive: true });
  } catch (err) {
    // A concurrent save may have registered it first; that is fine.
    if (err.code !== 11000) throw err;
  }
  return tidy;
}

/**
 * Register every formulation that products carry today and refresh the
 * per-formulation product counts. Idempotent; used by the backfill script.
 */
async function syncFormulationsFromProducts(Product) {
  const rows = await Product.aggregate([{ $group: { _id: '$formulation', n: { $sum: 1 } } }]);
  const created = [];
  for (const r of rows) {
    const tidy = tidyName(r._id);
    if (!tidy) continue;
    const before = await Formulation.countDocuments({});
    const stored = await registerFormulation(tidy);
    if ((await Formulation.countDocuments({})) > before) created.push(stored);
  }
  const all = await Formulation.find({});
  for (const f of all) {
    const count = await Product.countDocuments({ formulation: f.name });
    if (f.productsCount !== count) { f.productsCount = count; await f.save(); }
  }
  return { created, total: all.length };
}

module.exports = { registerFormulation, syncFormulationsFromProducts };
