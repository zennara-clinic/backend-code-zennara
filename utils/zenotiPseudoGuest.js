/**
 * Zenoti "guests" that are not people.
 *
 * The clinic holds time on the appointment book by booking a pseudo-guest
 * called "Meeting", "Reserved", "CRM Booking" and so on, and Zenoti's diary
 * feed also files every block-out under a guest whose id is the THERAPIST's
 * own id. Mirroring those as patients gave the Patients page rows named
 * "Meeting" with a join date of today and inflated every analytics count
 * (seen in the 2026-09-05 walkthrough).
 *
 * This is the single place that decides "is this a real guest". The roster
 * import, the appointment mirror and the clean-up script all ask it.
 */

const PSEUDO_NAME_RX = new RegExp(
  '^\\s*(?:'
  + 'meeting|meet|reserved?|reservation|hold|holding|block(?:ed|out|\\s*out)?|'
  + 'crm(?:\\s*(?:booking|call|calls))?|lunch|break|tea|training|maintenance|'
  + 'cleaning|do\\s*not\\s*book|dnb|unavailable|off|leave|holiday|'
  + 'test(?:ing)?(?:\\s*(?:guest|user|patient|account|employee|booking))?|'
  + 'dummy|sample|demo|walk-?in|walkin|counter\\s*sale|otc\\s*sale|pharmacy\\s*sale'
  + ')\\s*\\d*\\s*$',
  'i',
);

/** Trim, collapse spaces, drop a trailing "." Zenoti sometimes stores. */
function normalizeName(value) {
  return String(value || '').replace(/\s+/g, ' ').replace(/[.\s]+$/g, '').trim();
}

/**
 * Is this guest name a placeholder rather than a person?
 *
 * Accepts a full name or a first/last pair. A real guest with a first name
 * like "Meet" and a real surname is NOT pseudo: the rule only fires when the
 * WHOLE name is a placeholder word (optionally followed by a number).
 */
function isPseudoGuestName(fullName, lastName) {
  const name = normalizeName(lastName ? `${fullName || ''} ${lastName || ''}` : fullName);
  if (!name) return false;
  return PSEUDO_NAME_RX.test(name);
}

/**
 * Decide on a normalised guest (the shape zenotiService.normalizeGuest
 * returns) or a raw diary row. A block-out row is always pseudo, and so is a
 * row whose guest id is the therapist's own id — that is how Zenoti encodes
 * a block-out in the centre diary.
 */
function isPseudoGuest(guest, { therapistId = null, blockout = false } = {}) {
  if (blockout) return true;
  if (!guest) return false;
  const guestId = String(guest.zenotiGuestId || guest.id || '').toLowerCase();
  if (therapistId && guestId && guestId === String(therapistId).toLowerCase()) return true;
  const full = guest.fullName || guest.name || [guest.firstName || guest.first_name, guest.lastName || guest.last_name].filter(Boolean).join(' ');
  return isPseudoGuestName(full);
}

module.exports = { isPseudoGuestName, isPseudoGuest, PSEUDO_NAME_RX };
