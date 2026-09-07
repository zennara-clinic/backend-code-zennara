/**
 * The booking status vocabulary, in one place.
 *
 * Adding "Checked In" (Zenoti's own status 2, the guest is here but not yet in
 * a room) meant every `$in: ['Confirmed', 'In Progress', ...]` filter scattered
 * through the controllers had a hole in it: a checked-in guest would vanish
 * from the upcoming list, stop blocking their slot, and drop out of revenue.
 * Import from here rather than writing the array again.
 */

/** Occupies a diary slot — nobody else may be booked into it. */
const LIVE = ['Awaiting Confirmation', 'Confirmed', 'Rescheduled', 'Checked In', 'In Progress', 'Completed'];

/** Still ahead of the guest: shows in the app's Upcoming tab. */
const UPCOMING = ['Awaiting Confirmation', 'Confirmed', 'Rescheduled', 'Checked In', 'In Progress'];

/** Behind the guest: shows in the app's Past tab. */
const PAST = ['Cancelled', 'No Show', 'Completed'];

/** The guest turned up. Counts as a visit for stats, eligibility and revenue. */
const ATTENDED = ['Checked In', 'In Progress', 'Completed'];

/** In the building right now — the day book's "here" column. */
const PRESENT = ['Checked In', 'In Progress'];

/** Expected to happen and not yet finished: what the slot engine must respect. */
const BLOCKING = ['Awaiting Confirmation', 'Confirmed', 'Rescheduled', 'Checked In', 'In Progress'];

/** Counted as real business for analytics (booked, attending or attended). */
const COUNTABLE = ['Confirmed', 'Checked In', 'In Progress', 'Completed'];

module.exports = { LIVE, UPCOMING, PAST, ATTENDED, PRESENT, BLOCKING, COUNTABLE };
