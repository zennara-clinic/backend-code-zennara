/**
 * What a dermatologist's signature attests to, and whether a save changed it.
 *
 * Compared by value, never with Mongoose's isModified(): assigning an array
 * marks it modified even when every line is identical, and prescription lines
 * saved before a field existed read back without it. Both made an unchanged
 * autosave revoke a signature — and a revoked signature takes the prescription
 * off the guest's app. The free-text findings the guest reads on the signed
 * document are covered too, not only the medicines.
 */
const SIGNED_FIELDS = [
  'complaint', 'examination', 'assessment', 'plan', 'sketch',
  'prescription', 'assignedServices', 'followUpDate',
  'primaryDiagnosis', 'secondaryDiagnosis', 'skinCareAdvice', 'lifestyleAdvice', 'precautions',
];

/**
 * Keys the server writes on its own, never part of what was signed: ids, the
 * refill reminder's sent-stamp, refill days derived from the duration, and the
 * stock count shown at prescribing. Counting them would revoke a signature
 * the moment a reminder went out.
 */
const IGNORED_KEYS = new Set(['_id', 'id', '__v', 'refillReminderSentAt', 'refillAfterDays', 'availableQuantity']);

/**
 * A stable, comparable form of a value: server-written keys dropped, strings
 * trimmed, empty strings/arrays/objects treated as absent, keys sorted.
 */
function canonical(value) {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  if (typeof value === 'object' && typeof value.toHexString === 'function') return value.toHexString();
  if (Array.isArray(value)) {
    const out = value.map(canonical).filter((v) => v !== undefined);
    return out.length ? out : undefined;
  }
  if (typeof value === 'object') {
    const plain = typeof value.toObject === 'function' ? value.toObject({ depopulate: true }) : value;
    const out = {};
    for (const key of Object.keys(plain).sort()) {
      if (IGNORED_KEYS.has(key)) continue;
      const v = canonical(plain[key]);
      if (v !== undefined) out[key] = v;
    }
    return Object.keys(out).length ? out : undefined;
  }
  if (typeof value === 'string') {
    const t = value.trim();
    return t || undefined;
  }
  return value;
}

const plainOf = (doc) => (doc && typeof doc.toObject === 'function' ? doc.toObject({ depopulate: true }) : doc || {});

/** The signed content of a note (document or plain object), as one comparable string. */
function signedContent(note) {
  const plain = plainOf(note);
  const picked = {};
  for (const key of SIGNED_FIELDS) picked[key] = plain[key];
  return JSON.stringify(canonical(picked) || {});
}

module.exports = { SIGNED_FIELDS, canonical, signedContent, plainOf };
