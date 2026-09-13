/**
 * A centre's opening hours as one readable line, for messages that tell a
 * guest when to come in ("Mon–Sat 11:00–18:00 · Sun 11:00–15:00").
 *
 * Consecutive days with the same hours are folded into a range; closed days
 * are listed as such only when the week is not uniformly open, so the common
 * case stays short.
 */
const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const SHORT = { monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu', friday: 'Fri', saturday: 'Sat', sunday: 'Sun' };

function slotOf(hours, day) {
  const h = (hours || {})[day] || {};
  if (h.isOpen === false) return 'Closed';
  const open = h.openTime || h.open || '11:00';
  const close = h.closeTime || h.close || '18:00';
  return `${open}–${close}`;
}

function clinicHoursLine(branch) {
  const hours = branch?.operatingHours;
  if (!hours) return null;
  const groups = [];
  for (const day of DAYS) {
    const slot = slotOf(hours, day);
    const last = groups[groups.length - 1];
    if (last && last.slot === slot) last.to = day;
    else groups.push({ from: day, to: day, slot });
  }
  const open = groups.filter((g) => g.slot !== 'Closed');
  if (!open.length) return 'Closed all week';
  const fmt = (g) => `${g.from === g.to ? SHORT[g.from] : `${SHORT[g.from]}–${SHORT[g.to]}`} ${g.slot}`;
  const closed = groups.filter((g) => g.slot === 'Closed');
  const parts = open.map(fmt);
  if (closed.length) parts.push(`${closed.map((g) => (g.from === g.to ? SHORT[g.from] : `${SHORT[g.from]}–${SHORT[g.to]}`)).join(', ')} closed`);
  return parts.join(' · ');
}

module.exports = { clinicHoursLine };
