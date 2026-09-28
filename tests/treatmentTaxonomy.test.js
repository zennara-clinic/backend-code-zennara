/**
 * The treatment menu (utils/treatmentTaxonomy), the 2026-09 catalogue that seeds it
 * (data/treatmentCatalogue.js) and which service row a Zenoti id belongs to
 * (utils/zenotiServiceLink). No database.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { CATEGORIES, CONDITIONS, ICON_KEYS, normaliseConditions, normaliseIcon, buildTaxonomy, TREATMENT_TYPE } = require('../utils/treatmentTaxonomy');
const { preferMirror, zenotiLinkRank } = require('../utils/zenotiServiceLink');
const { treatments } = require('../data/treatmentCatalogue');

test('conditions are normalised to known keys, once each, in menu order', () => {
  assert.deepEqual(normaliseConditions(['Hair Loss', 'acne-scar', 'hair-loss', 'nonsense']), ['acne-scar', 'hair-loss']);
  assert.deepEqual(normaliseConditions('Tanned Skin, moles'), ['moles', 'tanned-skin']);
  assert.deepEqual(normaliseConditions(undefined), []);
});

test('only known icon keys are kept', () => {
  assert.equal(normaliseIcon('body'), 'body');
  assert.equal(normaliseIcon('  pigmentation '), 'pigmentation');
  assert.equal(normaliseIcon('rocket'), '');
  assert.equal(ICON_KEYS.length, CATEGORIES.length);
});

test('the menu lists categories in the panel order with icons, and leaves empty ones out', () => {
  const docs = [
    { name: 'Body', slug: 'body', icon: 'body', displayOrder: 9, isActive: true, type: TREATMENT_TYPE },
    { name: 'Laser Hair Reduction', slug: 'laser-hair-reduction', icon: 'laser-hair-reduction', displayOrder: 1, isActive: true, type: TREATMENT_TYPE },
    { name: 'More', slug: 'more', icon: 'more', displayOrder: 8, isActive: true, type: TREATMENT_TYPE },
  ];
  const rows = [
    { category: 'Body', conditions: [] },
    { category: 'Laser Hair Reduction', conditions: ['hypertrichosis'] },
    { category: 'Laser Hair Reduction', conditions: ['hypertrichosis', 'bogus'] },
  ];
  const menu = buildTaxonomy(rows, docs);
  assert.equal(menu.total, 3);
  assert.deepEqual(menu.categories.map((c) => [c.name, c.count, c.icon]), [['Laser Hair Reduction', 2, 'laser-hair-reduction'], ['Body', 1, 'body']]);
  assert.deepEqual(menu.conditions.map((c) => [c.key, c.count]), [['hypertrichosis', 2]]);
  const all = buildTaxonomy(rows, docs, { includeEmpty: true });
  assert.equal(all.conditions.length, CONDITIONS.length);
  assert.deepEqual(all.categories.map((c) => c.name), ['Laser Hair Reduction', 'More', 'Body']);
});

test('the 2026-09 catalogue is complete and consistent', () => {
  assert.equal(treatments.length, 64);
  const keys = new Set(CATEGORIES.map((c) => c.key));
  const slugs = new Set();
  for (const t of treatments) {
    assert.ok(keys.has(t.category), `${t.slug}: category`);
    // Every listed condition is known (they are stored in menu order, whatever order here).
    assert.deepEqual(normaliseConditions(t.conditions), [...t.conditions].sort((a, b) => CONDITIONS.findIndex((c) => c.key === a) - CONDITIONS.findIndex((c) => c.key === b)), `${t.slug}: conditions`);
    assert.ok(!slugs.has(t.slug), `${t.slug}: duplicate`);
    slugs.add(t.slug);
    assert.match(t.slug, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(t.summary && t.about, `${t.slug}: copy`);
    assert.ok(t.benefits.length >= 4 && t.idealFor.length >= 2 && t.faqs.length >= 3, `${t.slug}: sections`);
    // A name with "consult"/"counsel" is treated as a consultation across the stack.
    assert.doesNotMatch(t.name, /consult|counsel/i);
    // Our own copy: no other clinic named anywhere in it.
    assert.doesNotMatch(JSON.stringify(t), /oliva/i, `${t.slug}: names another clinic`);
  }
  for (const c of CATEGORIES) assert.ok(treatments.some((t) => t.category === c.key), `${c.key} is empty`);
  for (const c of CONDITIONS) assert.ok(treatments.some((t) => t.conditions.includes(c.key)), `${c.key} has no treatment`);
});

test('a Zenoti id resolves to the mirrored service, not an app-menu entry that books as it', () => {
  const mirror = { _id: 'm', zenotiServiceId: 'lhr', inCatalog: false };
  const menuA = { _id: 'a', zenotiServiceId: 'lhr', inCatalog: true };
  const menuB = { _id: 'b', zenotiServiceId: 'lhr', inCatalog: true };
  const archived = { _id: 'x', zenotiServiceId: 'lhr', inCatalog: false, isArchived: true };
  assert.deepEqual([menuA, mirror, archived].map(zenotiLinkRank), [0, 2, 1]);
  // Whatever the database order, a last-wins map built from preferMirror keeps the mirror.
  for (const order of [[mirror, menuA, menuB, archived], [menuA, menuB, archived, mirror], [archived, mirror, menuB]]) {
    const byId = new Map(preferMirror(order).map((c) => [c.zenotiServiceId, c]));
    assert.equal(byId.get('lhr')._id, 'm');
  }
  // With no mirror, an archived row beats a live menu entry; a menu entry only fills a gap.
  assert.equal(new Map(preferMirror([archived, menuA]).map((c) => [c.zenotiServiceId, c])).get('lhr')._id, 'x');
  assert.equal(new Map(preferMirror([menuA]).map((c) => [c.zenotiServiceId, c])).get('lhr')._id, 'a');
});
