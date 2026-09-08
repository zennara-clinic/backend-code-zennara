/**
 * The one answer to "is this slot still bookable" for the money path.
 *
 * There are two slot engines and they read different sources:
 *
 *   · services/zenotiAvailabilityService — LIVE Zenoti rosters. This is what
 *     the app's time picker offers the guest.
 *   · utils/dermatologistSlots — the local DermatologistSchedule, a frozen
 *     snapshot seeded from Zenoti (every row was last written 2026-09-04/07).
 *
 * The payment guards asked the LOCAL one, so they were validating against a
 * different picture from the one the guest was shown. They agree today only
 * because the snapshot was seeded from Zenoti and nobody's roster has moved
 * since. The moment one does — Janaki's local row is Thursday-only, so any
 * other day Zenoti gives her — the app offers a slot and the guard refuses it,
 * which after payment means charging the guest and refunding them.
 *
 * So: ask Zenoti, because that is what the guest was offered. Fall back to the
 * local snapshot only when Zenoti cannot answer at all (an outage or a rate
 * limit), because refusing every payment during a Zenoti hiccup is worse than
 * validating against a stale-but-close picture.
 */
const zenotiAvailability = require('../services/zenotiAvailabilityService');
const localSlots = require('./dermatologistSlots');
const logger = require('./logger');

async function isSlotBookable(doctorId, date, time, options = {}) {
  try {
    return await zenotiAvailability.isSlotBookable(doctorId, date, time, options);
  } catch (error) {
    // A configuration gap (doctor unmapped at this centre) is a real answer,
    // not an outage — do not paper over it with the stale snapshot.
    if (error?.code === 'ZENOTI_PRACTITIONER_UNMAPPED' || error?.code === 'AMBIGUOUS_ZENOTI_PRACTITIONER') {
      return { ok: false, reason: error.code };
    }
    logger.warn('Zenoti slot check unavailable — falling back to the local schedule', {
      doctorId, date, time, error: error.message,
    });
    return localSlots.isSlotBookable(doctorId, date, time, options);
  }
}

module.exports = { isSlotBookable };
