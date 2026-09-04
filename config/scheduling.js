/**
 * One appointment occupies one full hour across every active booking flow.
 *
 * This is deliberately global rather than a per-branch or per-doctor setting:
 * allowing those stored values to drift is what made one screen offer 10:30
 * while another treated 10:00–11:00 as the same session.
 */
const SESSION_SLOT_MINUTES = 60;

/**
 * The clinic-wide booking window (2026-09 policy).
 *
 *   Monday–Saturday  11:00 – 18:00
 *   Sunday           11:00 – 15:00
 *
 * Enforced in the slot engine (utils/dermatologistSlots.js), which every
 * surface goes through — the app's time picker, reception, admin, the
 * dermatologist panel, reschedule, and the guard that runs before a payment is
 * captured. Putting it here rather than in each UI is what stops a client from
 * offering, or a crafted request from booking, a time outside clinic hours.
 *
 * It is a CEILING, not a schedule: a dermatologist working 11:00–14:00 still
 * only offers 11:00–14:00, and a centre closed on a date is still closed. The
 * window can only ever narrow what those already allow.
 *
 * Keys are JavaScript's getDay() (0 = Sunday). Override with BOOKING_WINDOW as
 * JSON, e.g. {"0":{"start":"11:00","end":"15:00"}}; a day mapped to null is
 * closed clinic-wide.
 */
const DEFAULT_BOOKING_WINDOW = {
  0: { start: '11:00', end: '15:00' }, // Sunday
  1: { start: '11:00', end: '18:00' },
  2: { start: '11:00', end: '18:00' },
  3: { start: '11:00', end: '18:00' },
  4: { start: '11:00', end: '18:00' },
  5: { start: '11:00', end: '18:00' },
  6: { start: '11:00', end: '18:00' }, // Saturday
};

const BOOKING_WINDOW = (() => {
  const raw = process.env.BOOKING_WINDOW;
  if (!raw) return DEFAULT_BOOKING_WINDOW;
  try {
    const parsed = JSON.parse(raw);
    const out = {};
    for (let d = 0; d < 7; d += 1) {
      const hit = parsed[d] ?? parsed[String(d)];
      out[d] = hit === null ? null : (hit || DEFAULT_BOOKING_WINDOW[d]);
    }
    return out;
  } catch (_) {
    // A malformed override must not silently open the diary to 24 hours.
    return DEFAULT_BOOKING_WINDOW;
  }
})();

/** The clinic-wide window for a weekday index, or null when closed. */
function bookingWindowForDay(day) {
  return BOOKING_WINDOW[Number(day)] ?? null;
}

module.exports = {
  SESSION_SLOT_MINUTES,
  BOOKING_WINDOW,
  DEFAULT_BOOKING_WINDOW,
  bookingWindowForDay,
};
