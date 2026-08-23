/**
 * Server-side contract for the mobile app's remote design system.
 * Keeping this allow-list explicit prevents arbitrary Mixed fields from being
 * stored while still allowing every colour and text size used by the app.
 */
const COLOR_KEYS = new Set([
  'primary', 'primaryDark', 'secondary', 'gold', 'goldDark', 'white', 'black',
  'background', 'surface', 'sage', 'cream', 'ivory', 'overlay', 'overlaySoft',
  'text.primary', 'text.secondary', 'text.muted', 'text.tertiary',
  'text.inverse', 'text.onGold', 'text.brand',
  'border', 'borderStrong', 'borderFocus', 'borderLight', 'borderCream',
  'success', 'successSurface', 'warning', 'warningSurface', 'error',
  'errorSurface', 'info', 'infoSurface', 'disabled', 'disabledSurface',
  'disabledFill', 'primaryTint', 'primarySoft', 'surfaceMuted',
  'surfaceInverse', 'lightGray', 'accent', 'surfaceAlt', 'surfaceAccent',
  'forestGreen',
  'cardBackground', 'sheetBackground', 'modalBackground', 'headerBackground',
  'headerText', 'headerSubtext', 'headerIcon', 'headerActionBackground',
  'inputBackground', 'inputFocusedBackground', 'inputText',
  'inputPlaceholder', 'inputBorder', 'inputFocusedBorder',
  'primaryButtonBackground', 'primaryButtonPressed', 'primaryButtonText',
  'primaryButtonIcon', 'secondaryButtonBackground', 'secondaryButtonPressed',
  'secondaryButtonText', 'secondaryButtonIcon', 'secondaryButtonBorder',
  'goldButtonBackground', 'goldButtonPressed', 'goldButtonText',
  'ghostButtonPressed', 'ghostButtonText', 'inverseButtonBackground',
  'inverseButtonPressed', 'inverseButtonText', 'tabBackground',
  'tabActiveBackground', 'tabActiveIcon', 'tabInactiveIcon', 'tabActiveText',
  'tabInactiveText', 'iconPrimary', 'iconSecondary', 'iconMuted', 'iconInverse',
  'shadow', 'brandShadow', 'scrim', 'scrimStrong', 'mediaBackdrop',
  'mediaOverlay20', 'mediaOverlay25', 'mediaOverlay60', 'brandOverlay66',
  'mediaOverlay02', 'mediaOverlay38', 'dividerTranslucent', 'mapPinShadow',
  'authOverlay28', 'authOverlay34', 'authOverlay38', 'authOverlay70',
  'authOverlay72', 'authOverlay97',
  'onPrimary12', 'onPrimary14', 'onPrimary15', 'onPrimary16', 'onPrimary18',
  'onPrimary20', 'onPrimary22', 'onPrimary30', 'onPrimary32', 'onPrimary55',
  'onPrimary65', 'onPrimary70', 'onPrimary72', 'onPrimary75', 'onPrimary78',
  'onPrimary85', 'onPrimary90', 'onPrimary92', 'socialAccent', 'socialGold',
  'socialOrange', 'socialPurple', 'socialBlue',
]);

const FONT_BASE_SIZES = new Set([
  '8', '8.5', '9', '9.5', '10', '10.5', '11', '11.5', '12', '12.5',
  '13', '13.5', '14', '14.5', '15', '15.5', '16', '17', '18', '19',
  '20', '21', '22', '24', '26', '28', '32', '34', '36',
]);

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB = /^rgba?\(\s*(?:\d{1,3}\s*,\s*){2}\d{1,3}(?:\s*,\s*(?:0(?:\.\d+)?|1(?:\.0+)?))?\s*\)$/i;

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeAppearance(input) {
  if (input == null) return {};
  if (!plainObject(input)) throw badRequest('appearance must be an object');

  const clean = { colors: {}, typography: { fontScale: 1, sizeOverrides: {} } };
  if (input.colors != null) {
    if (!plainObject(input.colors)) throw badRequest('appearance.colors must be an object');
    for (const [key, raw] of Object.entries(input.colors)) {
      if (!COLOR_KEYS.has(key)) continue;
      if (typeof raw !== 'string' || (!HEX.test(raw.trim()) && !RGB.test(raw.trim()))) {
        throw badRequest(`Invalid colour value for ${key}`);
      }
      clean.colors[key] = raw.trim();
    }
  }

  if (input.typography != null) {
    if (!plainObject(input.typography)) throw badRequest('appearance.typography must be an object');
    if (input.typography.fontScale != null) {
      const scale = Number(input.typography.fontScale);
      if (!Number.isFinite(scale) || scale < 0.85 || scale > 1.3) {
        throw badRequest('fontScale must be between 0.85 and 1.3');
      }
      clean.typography.fontScale = Math.round(scale * 100) / 100;
    }
    if (input.typography.sizeOverrides != null) {
      if (!plainObject(input.typography.sizeOverrides)) {
        throw badRequest('sizeOverrides must be an object');
      }
      for (const [base, raw] of Object.entries(input.typography.sizeOverrides)) {
        if (!FONT_BASE_SIZES.has(base)) continue;
        const size = Number(raw);
        if (!Number.isFinite(size) || size < 8 || size > 48) {
          throw badRequest(`Font size for ${base} must be between 8 and 48`);
        }
        clean.typography.sizeOverrides[base] = Math.round(size * 2) / 2;
      }
    }
  }

  return clean;
}

module.exports = { COLOR_KEYS, FONT_BASE_SIZES, sanitizeAppearance };
