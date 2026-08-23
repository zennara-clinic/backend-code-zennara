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

/** Build a matcher once per sync from the roster. */
function buildDoctorMatcher(doctors) {
  const rows = doctors.map((d) => ({ doc: d, toks: tokens(d.name) }));
  return (name) => {
    const t = tokens(name);
    if (!t.length) return null;
    let best = null;
    let bestScore = 0;
    for (const r of rows) {
      const hits = t.filter((x) => r.toks.includes(x)).length;
      // First-name hit is decisive for this roster; require at least one token.
      const score = hits + (r.toks[0] && t.includes(r.toks[0]) ? 0.5 : 0);
      if (score > bestScore) { bestScore = score; best = r.doc; }
    }
    return bestScore >= 1 ? best : null;
  };
}

const tierTitle = (doc) => (doc && doc.tier === 'senior-consultant' ? 'Senior Dermatologist' : 'Dermatologist');

module.exports = { buildDoctorMatcher, tierTitle, tokens };
