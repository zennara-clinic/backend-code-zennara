const test = require('node:test');
const assert = require('node:assert/strict');

const T = require('../utils/productTaxonomy');
const Product = require('../models/Product');

/*
 * The shop's three axes — collections, categories, concerns — pinned at the
 * rules layer: what a save accepts, how the older `isPopular` switch and the
 * main category stay in step with the new lists, and what a guest's menu
 * leaves out.
 */

test('taxonomy: every area lists concerns that exist, and slugs are unique', () => {
  const slugs = T.CONCERNS.map((c) => c.slug);
  assert.equal(new Set(slugs).size, slugs.length);
  for (const area of T.CONCERN_AREAS) for (const slug of area.concerns) assert.ok(T.CONCERN_BY_SLUG.has(slug), `${area.name} → ${slug}`);
  // Nothing is orphaned: a concern no area lists could never be reached from the menu.
  const listed = new Set(T.CONCERN_AREAS.flatMap((a) => a.concerns));
  for (const slug of slugs) assert.ok(listed.has(slug), slug);
});

test('concerns: names and slugs both resolve, unknown ones are dropped, no duplicates', () => {
  assert.deepEqual(T.normaliseConcerns(['Acne', 'acne', 'Hairfall', 'Made Up']), ['acne', 'hairfall']);
  assert.deepEqual(T.normaliseConcerns('Dark Circles, puffy-eyes'), ['dark-circles', 'puffy-eyes']);
  assert.deepEqual(T.normaliseConcerns('Acne Marks & Blemishes'), ['acne-marks-blemishes']);
  assert.deepEqual(T.normaliseConcerns(undefined), []);
});

test('collections: only the three shelves, plural spellings accepted', () => {
  assert.deepEqual(T.normaliseCollections(['Bestsellers', 'new-arrivals', 'Kids', 'sale']), ['bestseller', 'new-arrival', 'kids']);
  assert.deepEqual(T.normaliseCollections('all'), []);
});

test('categories: a known one snaps to its spelling, a new one is kept as typed', () => {
  assert.deepEqual(T.normaliseCategories(['serums & essences', 'Moisturisers', 'Beard  Care']), ['Serums & Essences', 'Moisturisers', 'Beard Care']);
});

test('reconcile: the main category is always among the categories', () => {
  const p = T.reconcile({ productCategory: 'hair care', categories: ['Supplements'], shopCollections: [], concerns: [] });
  assert.equal(p.productCategory, 'Hair Care');
  assert.deepEqual(p.categories, ['Hair Care', 'Supplements']);
});

test('reconcile: editing the list alone moves the main category into it', () => {
  const p = T.reconcile({ productCategory: 'Toners', categories: ['Cleansers', 'Body Care'] }, { categories: true });
  assert.equal(p.productCategory, 'Cleansers');
  assert.deepEqual(p.categories, ['Cleansers', 'Body Care']);
  const kept = T.reconcile({ productCategory: 'Body Care', categories: ['Cleansers', 'Body Care'] }, { categories: true });
  assert.equal(kept.productCategory, 'Body Care');
});

test('reconcile: Bestsellers and isPopular are one switch, whichever was touched', () => {
  // The older panel and app only know isPopular.
  const on = T.reconcile({ isPopular: true, shopCollections: ['kids'] }, { isPopular: true });
  assert.deepEqual(on.shopCollections, ['bestseller', 'kids']);
  const off = T.reconcile({ isPopular: false, shopCollections: ['bestseller', 'kids'] }, { isPopular: true });
  assert.deepEqual(off.shopCollections, ['kids']);
  assert.equal(off.isPopular, false);
  // The new editor sends the shelves; they win.
  const shelves = T.reconcile({ isPopular: false, shopCollections: ['bestseller'] }, { isPopular: true, shopCollections: true });
  assert.equal(shelves.isPopular, true);
});

test('present: a guest never sees an empty shelf; the panel sees the whole menu', () => {
  const counts = {
    total: 3,
    collections: new Map([['bestseller', 2]]),
    categories: new Map([['Cleansers', 3], ['Beard Care', 1]]),
    concerns: new Map([['acne', 2]]),
  };
  const guest = T.present(counts);
  assert.deepEqual(guest.collections.map((c) => c.slug), ['bestseller']);
  assert.deepEqual(guest.categories.map((c) => c.name), ['Cleansers', 'Beard Care']);
  assert.deepEqual(guest.concerns.map((c) => c.slug), ['acne']);
  // Acne is a Face and a Body concern: both areas list it, the rest are gone.
  assert.deepEqual(guest.concernAreas.map((a) => a.slug), ['face', 'body']);
  const panel = T.present(counts, { includeEmpty: true });
  assert.equal(panel.collections.length, T.COLLECTIONS.length);
  assert.equal(panel.concerns.length, T.CONCERNS.length);
  assert.equal(panel.concernAreas.length, T.CONCERN_AREAS.length);
  assert.equal(panel.concerns.find((c) => c.slug === 'body-fat').count, 0);
});

test('category filter: matches the main category or any additional one', () => {
  assert.deepEqual(T.categoryFilter('hair care'), { $or: [{ categories: 'Hair Care' }, { productCategory: 'Hair Care' }] });
  assert.deepEqual(T.categoryFilter(''), {});
});

test('schema: the shop fields exist on the product, or a save would drop them silently', () => {
  for (const path of ['slug', 'shortDescription', 'categories', 'concerns', 'shopCollections', 'details.overview', 'details.keyIngredients', 'details.ingredients', 'details.howToUse', 'details.benefits', 'catalogueSource']) {
    assert.ok(Product.schema.path(path), path);
  }
  const p = new Product({ name: 'x', description: 'y', formulation: 'z', OrgName: 'o', price: 1, concerns: ['acne'], details: { howToUse: ['Apply.'] } });
  assert.deepEqual(p.toObject().concerns, ['acne']);
  assert.deepEqual(p.toObject().details.howToUse, ['Apply.']);
});
