/**
 * Marks a dermatologist draws on a clinical photograph.
 *
 * Stored as shapes, not as a flattened image: the photograph itself is never
 * altered, each mark can carry its own note, and marks can be moved, deleted
 * or hidden later. Geometry is in fractions of the image (0..1), so a mark
 * lands on the same spot whatever size the photo is shown at.
 */
const KINDS = ['ellipse', 'rect', 'arrow', 'pen'];
const MAX_MARKS = 60;
const MAX_POINTS = 1500;
const MAX_NOTE = 500;

const clamp01 = (n) => Math.min(1, Math.max(0, Number(n)));
const finite = (n) => Number.isFinite(Number(n));

function cleanPoints(points, min) {
  if (!Array.isArray(points)) return null;
  const out = [];
  for (const p of points.slice(0, MAX_POINTS)) {
    if (!Array.isArray(p) || !finite(p[0]) || !finite(p[1])) continue;
    out.push([Math.round(clamp01(p[0]) * 10000) / 10000, Math.round(clamp01(p[1]) * 10000) / 10000]);
  }
  return out.length >= min ? out : null;
}

/**
 * Validate what the panel sent. Unknown or malformed marks are dropped rather
 * than failing the save; authorship of a mark that already existed is kept.
 *
 * @param input     array from the request body
 * @param existing  the photo's current annotations (for authorship)
 * @param admin     req.admin, stamped on new marks
 */
function sanitizeAnnotations(input, existing = [], admin = null) {
  if (!Array.isArray(input)) return null;
  const before = new Map((existing || []).map((a) => [String(a._id), a]));
  const now = new Date();
  const out = [];

  for (const raw of input.slice(0, MAX_MARKS)) {
    if (!raw || !KINDS.includes(raw.kind)) continue;
    const mark = {
      kind: raw.kind,
      color: /^#[0-9a-f]{6}$/i.test(String(raw.color || '')) ? raw.color : '#D92D20',
      width: Math.min(12, Math.max(1, Math.round(Number(raw.width) || 3))),
      note: String(raw.note || '').trim().slice(0, MAX_NOTE),
    };

    if (raw.kind === 'ellipse' || raw.kind === 'rect') {
      if (![raw.x, raw.y, raw.w, raw.h].every(finite)) continue;
      mark.x = clamp01(raw.x);
      mark.y = clamp01(raw.y);
      mark.w = Math.min(1 - mark.x, Math.max(0, Number(raw.w)));
      mark.h = Math.min(1 - mark.y, Math.max(0, Number(raw.h)));
      if (mark.w < 0.002 && mark.h < 0.002) continue;
    } else {
      const points = cleanPoints(raw.points, raw.kind === 'pen' ? 2 : 2);
      if (!points) continue;
      mark.points = raw.kind === 'arrow' ? [points[0], points[points.length - 1]] : points;
    }

    const prior = raw._id ? before.get(String(raw._id)) : null;
    if (prior) {
      mark._id = prior._id;
      mark.createdBy = prior.createdBy || null;
      mark.createdByName = prior.createdByName || '';
      mark.createdAt = prior.createdAt || now;
    } else {
      mark.createdBy = admin?._id || null;
      mark.createdByName = admin?.name || '';
      mark.createdAt = now;
    }
    out.push(mark);
  }
  return out;
}

module.exports = { sanitizeAnnotations, KINDS, MAX_MARKS, MAX_NOTE };
