/**
 * Zenoti CRM configuration.
 *
 * Zennara runs on Zenoti. This file holds the non-secret configuration for the
 * integration: the API base URL, the mapping between Zenoti "centers" and the
 * app's own branches, and small helpers to normalise Zenoti's enums.
 *
 * Secrets (ZENOTI_API_KEY, ZENOTI_APPLICATION_ID, ZENOTI_SECRET) live only in
 * the environment and are read by services/zenotiService.js — never here, and
 * never sent to the client.
 */

const ZENOTI_API_BASE = process.env.ZENOTI_API_BASE || 'https://api.zenoti.com';

/**
 * Zenoti documents a standard limit of 60 requests/minute per organisation.
 * We queue below that with headroom so a burst never trips the org-wide 429.
 */
const RATE_LIMIT_PER_MINUTE = Number(process.env.ZENOTI_RATE_LIMIT || 50);

/**
 * The live centers, keyed by their Zenoti center id (from GET /v1/centers).
 *
 * `branchName` is the name of the matching Branch document in our own database,
 * so a Zenoti guest whose home center is Jubilee Hills is provisioned onto the
 * "Jubilee Hills" branch. Pharmacy centers and the training centre fold onto
 * their nearest public clinic for display purposes.
 */
const CENTERS = {
  'c9f032b2-4450-4a77-8ec8-641a26908d39': { code: 'ZENJH', name: 'Jubilee Hills', branchName: 'Jubilee Hills', isClinic: true },
  '9980db29-2a7b-49bd-a685-5d889a7917c6': { code: 'ZNFD', name: 'Financial District', branchName: 'Financial District', isClinic: true },
  '80963e4e-6625-4b83-8b88-9708c0cb2303': { code: 'ZNKD', name: 'Kondapur', branchName: 'Kondapur', isClinic: true },
  'e128ca1b-1f1d-4c17-abfb-8ef12a607917': { code: 'TC', name: 'Training Centre', branchName: 'Jubilee Hills', isClinic: false },
  '1ecf7d59-7ca2-43f5-a884-c8cf63dfc927': { code: 'ZNJHP', name: 'Jubilee Hills Pharmacy', branchName: 'Jubilee Hills', isClinic: false },
  'f503d08a-851a-4a82-a093-4f95f3e492cb': { code: 'ZNFDP', name: 'Financial District Pharmacy', branchName: 'Financial District', isClinic: false },
  '8625b58d-fc90-4f89-b461-d38bf475017f': { code: 'ZNKDP', name: 'Kondapur Pharmacy', branchName: 'Kondapur', isClinic: false },
};

/** The default branch a guest lands on when their home center can't be mapped. */
const DEFAULT_BRANCH_NAME = 'Jubilee Hills';

/**
 * Which Zenoti membership products count as Zennara's "Zen Member" tier.
 *
 * A guest holding a matching ACTIVE membership in Zenoti is treated as a Zen
 * Member in the app. Matching is case-insensitive substring on the membership
 * name. Set the exact product name(s) once known:
 *   ZENOTI_ZEN_MEMBERSHIP_NAMES="Zen Membership,Zen Wellness"
 * Default 'zen' matches any membership whose name contains "zen".
 */
const ZEN_MEMBERSHIP_MATCHERS = (process.env.ZENOTI_ZEN_MEMBERSHIP_NAMES || 'zen')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

/** Does this Zenoti membership name map to the app's Zen Member tier? */
function isZenMembership(name) {
  if (!name) return false;
  const lower = String(name).toLowerCase();
  return ZEN_MEMBERSHIP_MATCHERS.some((m) => lower.includes(m));
}

/** Is a Zenoti membership status considered active? */
function isActiveMembershipStatus(status) {
  if (status === undefined || status === null) return false;
  const s = String(status).toLowerCase();
  // Zenoti uses both strings and numeric codes across endpoints; treat the
  // common "active/1" forms as active and anything cancelled/expired as not.
  if (/cancel|expire|froze|frozen|inactive|suspend/.test(s)) return false;
  return s === 'active' || s === '1' || s === 'true' || /active/.test(s);
}

/** Look up a center's config by its Zenoti id. */
function centerById(centerId) {
  return (centerId && CENTERS[centerId]) || null;
}

/** Resolve a Zenoti home center id to the name of one of our Branch documents. */
function branchNameForCenter(centerId) {
  const center = centerById(centerId);
  return center ? center.branchName : DEFAULT_BRANCH_NAME;
}

/**
 * Reverse of branchNameForCenter: given one of our branch names, return the
 * Zenoti CLINIC center id to write bookings/guests against. Pharmacy/training
 * centres are never chosen as a write target. Falls back to the default branch's
 * clinic, then any clinic.
 */
function clinicCenterIdForBranch(branchName) {
  const wanted = String(branchName || '').trim().toLowerCase();
  const clinics = Object.entries(CENTERS).filter(([, c]) => c.isClinic);
  const exact = clinics.find(([, c]) => c.branchName.toLowerCase() === wanted);
  if (exact) return exact[0];
  const def = clinics.find(([, c]) => c.branchName === DEFAULT_BRANCH_NAME);
  if (def) return def[0];
  return clinics.length ? clinics[0][0] : null;
}

/**
 * Zenoti → app gender. Verified against this org's live data (and its
 * `gender_name` field): the integer enum is **0 = Female, 1 = Male,
 * -1 = NotSpecified**. Also accepts the string form ("Male"/"Female") and
 * Zenoti's `gender_name` so callers can pass either.
 */
function normalizeGender(zenotiGender) {
  if (zenotiGender === null || zenotiGender === undefined || zenotiGender === '') return 'Other';
  const s = String(zenotiGender).trim().toLowerCase();
  if (s === '1' || s === 'male') return 'Male';
  if (s === '0' || s === 'female') return 'Female';
  return 'Other'; // -1 / NotSpecified / anything else
}

/**
 * App → Zenoti gender, for guest writes. This org REJECTS 2 ("invalid gender");
 * valid values are -1 (NotSpecified), 0 (Female), 1 (Male).
 */
function toZenotiGender(appGender) {
  if (appGender === 'Male') return 1;
  if (appGender === 'Female') return 0;
  return -1;
}

/**
 * Normalise a phone number to the bare 10-digit form the app stores, dropping a
 * leading +91 / 91 / 0. Returns null when it isn't a usable Indian mobile.
 */
function normalizeIndianMobile(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  return null;
}

module.exports = {
  ZENOTI_API_BASE,
  RATE_LIMIT_PER_MINUTE,
  CENTERS,
  DEFAULT_BRANCH_NAME,
  centerById,
  branchNameForCenter,
  clinicCenterIdForBranch,
  normalizeGender,
  toZenotiGender,
  normalizeIndianMobile,
  isZenMembership,
  isActiveMembershipStatus,
};
