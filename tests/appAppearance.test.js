const test = require('node:test');
const assert = require('node:assert/strict');

const { COLOR_KEYS, FONT_BASE_SIZES, sanitizeAppearance } = require('../utils/appAppearance');
const AppCustomization = require('../models/AppCustomization');

test('appearance saves component roles and exact typography overrides', () => {
  const clean = sanitizeAppearance({
    colors: {
      primaryButtonBackground: '#123456',
      inputPlaceholder: 'rgba(12, 34, 56, 0.7)',
      'text.primary': '#111',
    },
    typography: {
      fontScale: 1.15,
      sizeOverrides: { '8.5': 10, '14': 16.26, '36': 44 },
    },
  });

  assert.deepEqual(clean.colors, {
    primaryButtonBackground: '#123456',
    inputPlaceholder: 'rgba(12, 34, 56, 0.7)',
    'text.primary': '#111',
  });
  assert.equal(clean.typography.fontScale, 1.15);
  assert.deepEqual(clean.typography.sizeOverrides, { '8.5': 10, '14': 16.5, '36': 44 });
});

test('appearance rejects invalid colours and out-of-range typography', () => {
  assert.throws(
    () => sanitizeAppearance({ colors: { primary: 'url(javascript:bad)' } }),
    /Invalid colour value/
  );
  assert.throws(
    () => sanitizeAppearance({ typography: { fontScale: 2 } }),
    /between 0.85 and 1.3/
  );
  assert.throws(
    () => sanitizeAppearance({ typography: { sizeOverrides: { '14': 60 } } }),
    /between 8 and 48/
  );
});

test('appearance allow-list covers every remotely editable role and base size', () => {
  for (const key of ['headerIcon', 'secondaryButtonBorder', 'tabInactiveText', 'mediaOverlay60']) {
    assert.ok(COLOR_KEYS.has(key), `${key} should be editable`);
  }
  for (const base of ['8', '8.5', '14', '22', '36']) {
    assert.ok(FONT_BASE_SIZES.has(base), `${base} should be editable`);
  }
});

test('Mixed design fields replace old overrides so reset and deletion persist', async () => {
  const settings = new AppCustomization({
    appearance: { colors: { primary: '#123456', error: '#ff0000' } },
    copy: { 'home.book.cta': 'Old text' },
  });
  settings.save = async () => settings;

  await settings.updateSettings(
    { appearance: { colors: {}, typography: { fontScale: 1, sizeOverrides: {} } }, copy: {} },
    null
  );

  assert.deepEqual(settings.appearance, {
    colors: {},
    typography: { fontScale: 1, sizeOverrides: {} },
  });
  assert.deepEqual(settings.copy, {});
});
