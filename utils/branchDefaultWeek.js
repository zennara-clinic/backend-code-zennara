/**
 * The automatic default week for a dermatologist: each weekday any of their
 * centres is open becomes a working day spanning the earliest open to the
 * latest close across those centres (branchId null — slot reads clamp to each
 * centre's own hours anyway).
 *
 * One implementation for both users: the seed that runs when centres are
 * assigned, and the panel's "Reset to centre hours" action.
 */
const DermatologistSchedule = require('../models/DermatologistSchedule');

const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** `branches` are lean Branch docs carrying operatingHours. */
function defaultWeeklyFromBranches(branches) {
  const weekly = [];
  for (let day = 0; day < 7; day += 1) {
    let open = null;
    let close = null;
    for (const b of branches || []) {
      const h = b.operatingHours && b.operatingHours[DAY_KEYS[day]];
      if (!h || h.isOpen === false) continue;
      const o = DermatologistSchedule.toMinutes(h.openTime || '10:00');
      const c = DermatologistSchedule.toMinutes(h.closeTime || '19:00');
      if (o === null || c === null || c <= o) continue;
      open = open === null ? o : Math.min(open, o);
      close = close === null ? c : Math.max(close, c);
    }
    if (open !== null && close !== null) {
      weekly.push({
        day,
        branchId: null,
        ranges: [{ start: DermatologistSchedule.toHHMM(open), end: DermatologistSchedule.toHHMM(close) }],
      });
    }
  }
  return weekly;
}

module.exports = { defaultWeeklyFromBranches };
