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

/** Build a matcher once per sync from the roster. */
function buildDoctorMatcher(doctors) {
  const rows = doctors.map((d) => ({ doc: d, toks: tokens(d.name) }));
  return (name) => {
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
}

const tierTitle = (doc) => (doc && doc.tier === 'senior-consultant' ? 'Senior Dermatologist' : 'Dermatologist');

module.exports = { buildDoctorMatcher, tierTitle, tokens, canonicalName };
