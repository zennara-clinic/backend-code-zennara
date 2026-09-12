/**
 * The free consultation that comes with an ongoing treatment package.
 *
 * A guest mid-way through a package can ask to see the dermatologist treating
 * them, at no charge. Two questions have to be answered before that booking
 * can be raised, and both are answered here so the app's "who will I see"
 * call and the booking endpoint can never disagree:
 *
 *   · WHO is treating them under this package — `treatingDoctorFor`.
 *   · Whether the package still INCLUDES that consultation —
 *     `packageConsultEligibility`.
 *
 * Both are pure over the assignment apart from two lookups (the Doctor
 * profile and, as a last resort, the guest's booking history), which are
 * injectable so the ordering rules can be tested without a database.
 */
const DoctorModel = require('../models/Doctor');
const BookingModel = require('../models/Booking');

const slug = (value) => String(value || '').trim().toLowerCase();

/** An active Doctor profile for a doctorId slug, or null. */
async function activeDoctor(Doctor, doctorId) {
  const id = slug(doctorId);
  if (!id) return null;
  return Doctor.findOne({ doctorId: id, isActive: { $ne: false } });
}

/**
 * The specialist on the latest session that is still open ('Booked' or
 * 'Scheduled'). "Latest" is by scheduledDate; a session with no date yet sorts
 * oldest, and among equals the row further down the list wins — the course
 * moves forward through the array.
 */
function latestOpenSessionSpecialist(sessions) {
  const open = sessions
    .map((s, index) => ({ s, index }))
    .filter(({ s }) => slug(s.specialistId) && ['Booked', 'Scheduled'].includes(s.status));
  if (!open.length) return null;
  open.sort((a, b) => {
    const da = a.s.scheduledDate ? new Date(a.s.scheduledDate).getTime() : -Infinity;
    const db = b.s.scheduledDate ? new Date(b.s.scheduledDate).getTime() : -Infinity;
    if (da !== db) return db - da;
    return b.index - a.index;
  });
  return slug(open[0].s.specialistId);
}

/**
 * The specialist who appears on the most sessions, whatever their status. A
 * tie goes to whichever of them appears later in the list (the more recent
 * hand of the course).
 */
function mostFrequentSpecialist(sessions) {
  const counts = new Map();
  const lastSeen = new Map();
  sessions.forEach((s, index) => {
    const id = slug(s.specialistId);
    if (!id) return;
    counts.set(id, (counts.get(id) || 0) + 1);
    lastSeen.set(id, index);
  });
  let best = null;
  for (const [id, n] of counts) {
    if (!best || n > best.n || (n === best.n && lastSeen.get(id) > best.last)) best = { id, n, last: lastSeen.get(id) };
  }
  return best ? best.id : null;
}

/**
 * Which dermatologist is treating this guest under the package.
 *
 * In order: the specialist on the latest open session; failing that, the one
 * who has run most of the sessions; failing that, whoever the guest last
 * completed a consultation with. A candidate that no longer maps to an active
 * Doctor profile (retired, renamed) is skipped rather than returned, so the
 * caller always gets someone who can actually be booked — or null.
 *
 * @returns {Promise<{ doctor: object|null, reason: 'session'|'sessions'|'history'|null }>}
 */
async function treatingDoctorFor(assignment, { userId = null, Doctor = DoctorModel, Booking = BookingModel } = {}) {
  const sessions = Array.isArray(assignment?.sessions) ? assignment.sessions : [];

  const fromOpen = await activeDoctor(Doctor, latestOpenSessionSpecialist(sessions));
  if (fromOpen) return { doctor: fromOpen, reason: 'session' };

  const fromCount = await activeDoctor(Doctor, mostFrequentSpecialist(sessions));
  if (fromCount) return { doctor: fromCount, reason: 'sessions' };

  const owner = userId || assignment?.userId;
  if (owner) {
    const last = await Booking.findOne({
      userId: owner,
      status: 'Completed',
      specialistId: { $type: 'string', $ne: '' },
    })
      // eventAt is the one ordering field (see Booking.eventAt); confirmedDate
      // breaks ties for rows written before it existed.
      .sort({ eventAt: -1, confirmedDate: -1 })
      .select('specialistId')
      .lean();
    const fromHistory = await activeDoctor(Doctor, last?.specialistId);
    if (fromHistory) return { doctor: fromHistory, reason: 'history' };
  }

  return { doctor: null, reason: null };
}

/**
 * Plain-English reasons a guest can read. `redeemable()`'s own messages are
 * written for the desk ("Unfreeze it first"), so they are translated here
 * rather than passed through.
 */
const REASONS = {
  PACKAGE_EXPIRED: 'This package has ended, so a free consultation is no longer included.',
  PACKAGE_CANCELLED: 'This package was cancelled, so a free consultation is no longer included.',
  PACKAGE_COMPLETED: 'Every session in this package has been used, so a free consultation is no longer included.',
  PACKAGE_NO_SESSIONS_LEFT: 'Every session in this package has been used, so a free consultation is no longer included.',
  PACKAGE_FROZEN: 'This package is frozen at the moment. Ask the clinic to unfreeze it and the free consultation comes back.',
  PACKAGE_WRONG_CENTRE: 'This package can only be used at the centre it was sold for — please book the consultation there.',
  PACKAGE_NOT_ACTIVE: 'This package is not active, so a free consultation is not included right now.',
};

/**
 * Does this package still include a free consultation?
 *
 * It does while the package is Active, redeemable here and now (not frozen,
 * not past its grace period, sold for this centre) and still has sessions
 * owed. A package with everything used but not yet closed is treated like a
 * completed one: the consultation is part of the ongoing treatment, not a
 * standalone benefit.
 *
 * @returns {{ ok: boolean, code: string|null, message: string|null }}
 */
function packageConsultEligibility(assignment, { branchId = null, at = new Date() } = {}) {
  if (!assignment) return { ok: false, code: 'PACKAGE_NOT_FOUND', message: 'We could not find this package.' };

  if (assignment.status !== 'Active') {
    const code = 'PACKAGE_' + String(assignment.status || '').toUpperCase();
    return { ok: false, code, message: REASONS[code] || REASONS.PACKAGE_NOT_ACTIVE };
  }

  const redeem = typeof assignment.redeemable === 'function'
    ? assignment.redeemable({ branchId, at })
    : { ok: true };
  if (!redeem.ok) {
    return { ok: false, code: redeem.code || 'PACKAGE_NOT_ACTIVE', message: REASONS[redeem.code] || redeem.message || REASONS.PACKAGE_NOT_ACTIVE };
  }

  const balances = typeof assignment.serviceBalances === 'function' ? assignment.serviceBalances() : [];
  const left = balances.reduce((n, row) => n + (Number(row.balance) || 0), 0);
  if (balances.length && left <= 0) {
    return { ok: false, code: 'PACKAGE_NO_SESSIONS_LEFT', message: REASONS.PACKAGE_NO_SESSIONS_LEFT };
  }

  return { ok: true, code: null, message: null };
}

/** The package's name for display — the sale-time snapshot first, then the catalogue row. */
function describe(assignment) {
  return assignment?.packageDetails?.packageName
    || (assignment?.packageId && typeof assignment.packageId === 'object' ? assignment.packageId.name : null)
    || 'your package';
}

module.exports = { treatingDoctorFor, packageConsultEligibility, describe, REASONS };
