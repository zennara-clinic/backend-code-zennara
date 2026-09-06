/**
 * Match a free-text practitioner name from Zenoti ("Dr Shilpa Gill",
 * "Dr.Madhurya", "Janaki") to a Doctor on our roster. Zenoti's appointment
 * book files the dermatologist under `therapist`, so this is how clinic visits
 * get attributed to the right dermatologist for the leaderboard and filters.
 */
const tokens = (s) => String(s || '')
  .toLowerCase()
  .replace(/\bdr\.?\s*/g, ' ')
  .replace(/[^a-z\s]/g, ' ')
  .split(/\s+/)
  .filter((t) => t.length > 1);

// Identity/filter keys retain initials ("Dr Aditi J" must not collapse into a
// different Dr Aditi). The fuzzy matcher below deliberately uses the stricter
// token set, which ignores one-letter noise while scoring names.
const canonicalName = (s) => String(s || '')
  .toLowerCase()
  .replace(/\bdr\.?\s*/g, ' ')
  .replace(/[^a-z\s]/g, ' ')
  .split(/\s+/)
  .filter(Boolean)
  .join(' ');

/**
 * Zenoti sometimes rosters two doctors as ONE employee so they can share a
 * column ("Dr Varsha-Dr Bandhavi M Sane", "Dr Varsha & Dr Bandhavi"). Split
 * such a label into its people; a plain name comes back as itself.
 */
function splitCombinedName(name) {
  const raw = String(name || '').trim();
  if (!raw) return [];
  // Split only where a separator is followed by another "Dr" — a hyphenated
  // surname ("Reddy-Gill") must stay whole.
  const parts = raw.split(/\s*(?:[-–—/&,+]|\band\b)\s*(?=dr\.?\s)/i).map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts : [raw];
}

/** Build a matcher once per sync from the roster. */
function buildDoctorMatcher(doctors) {
  const rows = doctors.map((d) => ({ doc: d, toks: tokens(d.name) }));
  const matchOne = (name) => {
    const t = tokens(name);
    if (!t.length) return null;
    const exact = rows.find((r) => r.toks.join(' ') === t.join(' '));
    if (exact) return exact.doc;

    // Zenoti and the app sometimes disagree on a doctor's surname
    // (for example a married name), while their first name remains stable.
    // A first-name fallback is safe only when that first name is unique in the
    // onboarded roster. Appointment sync calls this matcher only after the
    // employee has independently been classified as a Zenoti Doctor.
    const first = t[0];
    const firstMatches = rows.filter((r) => r.toks[0] === first);
    if (firstMatches.length === 1) return firstMatches[0].doc;

    // Otherwise require strong agreement in both directions. This prevents a
    // therapist with one coincidental token from being assigned to a doctor.
    const scored = rows.map((r) => {
      const hits = t.filter((x) => r.toks.includes(x)).length;
      return { row: r, coverage: hits / Math.max(1, r.toks.length), precision: hits / t.length, hits };
    }).filter((x) => x.hits >= 2 && x.coverage >= 0.65 && x.precision >= 0.65)
      .sort((a, b) => (b.coverage + b.precision) - (a.coverage + a.precision));
    return scored.length === 1 || (scored[0] && scored[1] && (scored[0].coverage + scored[0].precision) > (scored[1].coverage + scored[1].precision) + 0.25)
      ? scored[0].row.doc
      : null;
  };
  // A combined label resolves to its FIRST named doctor (the column owner in
  // Zenoti); `matchAll` gives every person for callers that can hold several.
  const matcher = (name) => {
    const direct = matchOne(name);
    if (direct) return direct;
    const parts = splitCombinedName(name);
    if (parts.length < 2) return null;
    for (const part of parts) { const hit = matchOne(part); if (hit) return hit; }
    return null;
  };
  matcher.matchAll = (name) => {
    const parts = splitCombinedName(name);
    const hits = parts.map(matchOne).filter(Boolean);
    return [...new Map(hits.map((d) => [String(d.doctorId || d._id), d])).values()];
  };
  return matcher;
}

const tierTitle = (doc) => (doc && doc.tier === 'senior-consultant' ? 'Senior Dermatologist' : 'Dermatologist');

module.exports = { buildDoctorMatcher, tierTitle, tokens, canonicalName, splitCombinedName };
