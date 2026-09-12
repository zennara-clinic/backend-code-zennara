/**
 * The one place an appointment's status is allowed to move.
 *
 * Zennara's desk actions are deliberately the same set the clinic already
 * knows from Zenoti's appointment book, with the same shape and the same undo
 * steps, so a receptionist looking at our panel and a manager looking at the
 * Zenoti mobile app never see two different stories:
 *
 *     Booked ─confirm─▶ Confirmed ─check_in─▶ Checked In ─start─▶ In Progress
 *                                       │                              │
 *                                   no_show                        complete
 *                                       ▼                              ▼
 *                                    No Show                       Completed
 *
 * Every step has an undo, because the desk mis-taps and Zenoti allows it:
 * undo_check_in, undo_start, undo_no_show, and the existing cancel/undo path.
 * Completion is the exception — Zenoti refuses to reopen a closed visit, so the
 * panel does not offer it (see RETIRED in apply()).
 *
 * Two rules make this safe:
 *
 *  1. A transition is only legal from the states listed for it. The panel
 *     shows exactly the actions this booking can take right now, and the
 *     server re-checks — a stale panel tab cannot complete a visit that was
 *     never started.
 *
 *  2. Check-in is time-boxed. Nobody is "at the clinic" an hour before their
 *     slot; letting the desk check them in then produced arrival times that
 *     were fiction and no-show reports that were wrong. Check-in opens
 *     CHECKIN_EARLY_MINUTES before the slot. Staff may override with a typed
 *     reason, which is recorded on the booking.
 *
 * The Zenoti call for each action is declared here too, so "what does this
 * button do in the CRM" is answerable by reading one table.
 */

const Booking = require('../models/Booking');
const logger = require('../utils/logger');
const { bookingScheduledAt, clinicDateKey, clinicDayStart } = require('../utils/bookingTime');

/** How long before the slot check-in opens. */
const EARLY_MINUTES = Math.max(0, Number(process.env.CHECKIN_EARLY_MINUTES) || 30);
/**
 * How long after the slot check-in stays open. Generous on purpose: a guest who
 * turns up 40 minutes late is late, not absent, and the desk still has to
 * record the visit. The no-show job (bookingStatusService) is what decides
 * absence.
 */
const LATE_MINUTES = Math.max(30, Number(process.env.CHECKIN_LATE_MINUTES) || 240);

class LifecycleError extends Error {
  constructor(message, { status = 400, code = null, meta = null } = {}) {
    super(message);
    this.name = 'LifecycleError';
    this.status = status;
    this.code = code;
    this.meta = meta;
  }
}

/**
 * The action table.
 *
 * `zenoti` names the call the write service makes for this action; null means
 * the action is local-only (Zenoti has no equivalent, or the clinic's API user
 * is not permitted — see `undo_no_show`).
 */
const ACTIONS = {
  confirm: {
    label: 'Confirm',
    from: ['Awaiting Confirmation', 'Rescheduled'],
    to: 'Confirmed',
    zenoti: 'confirm',
  },
  check_in: {
    label: 'Check in',
    from: ['Confirmed', 'Rescheduled', 'No Show'],
    to: 'Checked In',
    zenoti: 'check_in',
    timeBoxed: true,
  },
  undo_check_in: {
    label: 'Undo check-in',
    from: ['Checked In'],
    to: 'Confirmed',
    zenoti: 'undo_check_in',
  },
  start: {
    label: 'Start session',
    from: ['Checked In'],
    to: 'In Progress',
    zenoti: 'start',
  },
  undo_start: {
    label: 'Undo start',
    from: ['In Progress'],
    to: 'Checked In',
    zenoti: 'undo_start',
  },
  complete: {
    label: 'Complete session',
    from: ['In Progress'],
    to: 'Completed',
    zenoti: 'complete',
  },
  no_show: {
    label: 'Mark no show',
    from: ['Confirmed', 'Rescheduled', 'Awaiting Confirmation'],
    to: 'No Show',
    zenoti: 'no_show',
  },
  undo_no_show: {
    label: 'Undo no show',
    from: ['No Show'],
    to: 'Confirmed',
    // Zenoti exposes no undo_no_show route (probed 2026-09-07: 404), so this
    // corrects our record only. The panel says so, rather than pretending.
    zenoti: null,
  },
  cancel: {
    label: 'Cancel',
    from: ['Awaiting Confirmation', 'Confirmed', 'Rescheduled', 'Checked In'],
    to: 'Cancelled',
    zenoti: 'cancel',
  },
  undo_cancel: {
    label: 'Undo cancel',
    from: ['Cancelled'],
    to: null, // computed: Confirmed if it has a fixed slot, else Awaiting
    zenoti: null,
    pastDayBlocked: true,
  },
};

/**
 * A guest who booked in Zenoti is Zenoti's to schedule. The desk may still
 * record what happened in the room here (and that IS pushed back), but moving,
 * cancelling, confirming or no-showing such an appointment is done in Zenoti.
 * Kept as data rather than scattered `if (source === 'zenoti')` checks.
 */
const ZENOTI_OWNED_BLOCKED = new Set(['confirm', 'cancel', 'no_show', 'undo_cancel', 'undo_no_show']);

/** Actions the panel may offer for a booking in this state, in display order. */
function availableActions(booking) {
  const order = [
    'confirm', 'check_in', 'start', 'complete',
    'undo_start', 'undo_check_in', 'undo_no_show', 'undo_cancel',
    'no_show', 'cancel',
  ];
  return order.filter((name) => {
    const spec = ACTIONS[name];
    if (!spec.from.includes(booking.status)) return false;
    if (booking.source === 'zenoti' && ZENOTI_OWNED_BLOCKED.has(name)) return false;
    if (spec.zenoti === null && (booking.zenotiAppointmentId || booking.zenotiInvoiceId)) return false;
    return true;
  });
}

/**
 * Is it time to check this guest in?
 *
 * Returns { ok, opensAt, closesAt, reason }. A booking with no fixed time yet
 * (a treatment awaiting confirmation of one of three preferred slots) has no
 * window to enforce, so it passes.
 */
function checkInWindow(booking, now = new Date()) {
  const start = bookingScheduledAt(booking);
  if (!start) return { ok: true, opensAt: null, closesAt: null, reason: null };
  const opensAt = new Date(start.getTime() - EARLY_MINUTES * 60_000);
  const closesAt = new Date(start.getTime() + LATE_MINUTES * 60_000);
  const at = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  if (now < opensAt) {
    const mins = Math.round((opensAt - now) / 60_000);
    return {
      ok: false, opensAt, closesAt, code: 'CHECKIN_TOO_EARLY',
      reason: `This session starts at ${at.format(start)}. Check-in opens at ${at.format(opensAt)} — ${mins} minute${mins === 1 ? '' : 's'} from now.`,
    };
  }
  if (now > closesAt) {
    return {
      ok: false, opensAt, closesAt, code: 'CHECKIN_TOO_LATE',
      reason: `Check-in for the ${at.format(start)} session closed at ${at.format(closesAt)}.`,
    };
  }
  return { ok: true, opensAt, closesAt, reason: null };
}

/** Everything the panel needs to render this booking's action bar. */
function lifecycleState(booking, now = new Date()) {
  const actions = availableActions(booking).map((name) => {
    const spec = ACTIONS[name];
    const row = { action: name, label: spec.label, needsReason: Boolean(spec.needsReason) };
    if (spec.timeBoxed) {
      const window = checkInWindow(booking, now);
      row.blocked = !window.ok;
      row.blockedReason = window.reason;
      row.opensAt = window.opensAt;
      row.overridable = true;
      if (!window.ok) row.needsReason = true;
    }
    if (spec.zenoti === null) row.localOnly = true;
    return row;
  });
  return {
    status: booking.status,
    actions,
    checkInWindow: checkInWindow(booking, now),
    earlyMinutes: EARLY_MINUTES,
  };
}

/**
 * Apply a lifecycle action.
 *
 * Throws LifecycleError with a message written for the person at the desk.
 * On success the booking is saved, an entry is appended to `statusLog`, and
 * Zenoti is updated (then re-read) in the background.
 */
async function apply(bookingOrId, action, {
  admin = null,
  reason = '',
  force = false,
  via = 'panel',
  now = new Date(),
  mutate = null,
} = {}) {
  /*
   * Actions the desk used to have and no longer does. Named explicitly so a
   * stale panel tab or an old client gets the reason rather than the useless
   * `Unknown action "undo_complete"`.
   *
   * Reopening a completed visit is gone because ZENOTI CANNOT DO IT: the
   * progress endpoint answers `You cannot start appointments that are already
   * completed` (code AA102), and every completed booking here is a Zenoti
   * appointment — a visit only reaches Completed through a confirm that
   * Zenoti accepted. Offering a button that can only ever fail is worse than
   * not offering it. Correct a wrongly-completed visit in Zenoti; it reaches
   * the panel within about ten seconds.
   */
  const RETIRED = {
    undo_complete: 'Reopening a completed visit is done in Zenoti — Zenoti does not accept it from here (error AA102). The change appears in the panel within about 10 seconds.',
  };
  if (RETIRED[action]) throw new LifecycleError(RETIRED[action], { status: 400, code: 'ACTION_RETIRED' });

  const spec = ACTIONS[action];
  if (!spec) throw new LifecycleError(`Unknown action "${action}".`, { status: 400 });

  const booking = typeof bookingOrId === 'object' && bookingOrId._id
    ? bookingOrId
    : await Booking.findById(bookingOrId);
  if (!booking) throw new LifecycleError('Booking not found', { status: 404 });

  const from = booking.status;
  if (!spec.from.includes(from)) {
    throw new LifecycleError(
      `${spec.label} isn't available for a booking that is ${from.toLowerCase()}.`,
      { status: 409, code: 'ILLEGAL_TRANSITION', meta: { from, allowedFrom: spec.from } },
    );
  }

  if (booking.source === 'zenoti' && ZENOTI_OWNED_BLOCKED.has(action)) {
    throw new LifecycleError(
      'This appointment was booked in Zenoti. Confirm, cancel, reschedule and no-show are done in Zenoti — the change appears here within two minutes. Check-in, start and completion can be recorded here.',
      { status: 409, code: 'ZENOTI_OWNED_APPOINTMENT' },
    );
  }

  if (spec.zenoti === null && (booking.zenotiAppointmentId || booking.zenotiInvoiceId)) {
    throw new LifecycleError(
      `${spec.label} has no supported Zenoti API operation. Make this correction in Zenoti so the two systems cannot diverge.`,
      { status: 409, code: 'ZENOTI_ACTION_UNSUPPORTED' },
    );
  }

  const trimmedReason = String(reason || '').trim();
  let overrode = false;

  if (spec.timeBoxed) {
    const window = checkInWindow(booking, now);
    if (!window.ok) {
      if (!force) {
        throw new LifecycleError(window.reason, {
          status: 409,
          code: window.code,
          meta: { opensAt: window.opensAt, closesAt: window.closesAt, overridable: true },
        });
      }
      if (trimmedReason.length < 3) {
        throw new LifecycleError(
          `${window.reason} To check in anyway, give a reason.`,
          { status: 400, code: 'OVERRIDE_REASON_REQUIRED', meta: { opensAt: window.opensAt } },
        );
      }
      overrode = true;
    }
  }

  if (spec.needsReason && trimmedReason.length < 3) {
    throw new LifecycleError(`${spec.label} needs a reason.`, { status: 400, code: 'REASON_REQUIRED' });
  }

  const visitKey = clinicDateKey(booking.confirmedDate || booking.preferredDate);
  const todayKey = clinicDateKey(now);
  if (spec.sameDayOnly && visitKey && visitKey !== todayKey) {
    throw new LifecycleError('Only a visit from today can be reopened.', { status: 400 });
  }
  if (spec.pastDayBlocked && visitKey && visitKey < todayKey) {
    throw new LifecycleError('A past cancellation cannot be undone — book a new appointment instead.', { status: 400 });
  }

  const to = action === 'undo_cancel'
    ? (booking.confirmedDate && booking.confirmedTime ? 'Confirmed' : 'Awaiting Confirmation')
    : spec.to;

  // Zenoti first: a panel action is not successful until the primary system
  // accepts it. Awaiting requests with no Zenoti record may still be cancelled
  // or no-showed locally because there is nothing external to update.
  let zenotiOutcome = null;
  const needsZenoti = Boolean(spec.zenoti) && (
    booking.zenotiAppointmentId || booking.zenotiInvoiceId
    || (!['Awaiting Confirmation', 'Rescheduled'].includes(from) && booking.source !== 'zenoti')
  );
  if (needsZenoti) {
    const write = require('./zenotiWriteService');
    zenotiOutcome = await write.pushLifecycleAction(booking._id, spec.zenoti);
    if (zenotiOutcome.status !== 'synced') {
      throw new LifecycleError(
        zenotiOutcome.error || `Zenoti did not accept ${spec.label.toLowerCase()}. Nothing was changed locally.`,
        {
          status: zenotiOutcome.status === 'off' || zenotiOutcome.status === 'dryrun' ? 503 : 502,
          code: 'ZENOTI_LIFECYCLE_FAILED',
          meta: { zenotiStatus: zenotiOutcome.status },
        },
      );
    }
  }

  applySideEffects(booking, action, { to, now, admin, reason: trimmedReason });
  if (typeof mutate === 'function') await mutate(booking);

  booking.status = to;
  booking.statusLog = booking.statusLog || [];
  const entry = {
    action, from, to, at: now,
    by: admin && admin._id ? admin._id : null,
    byName: (admin && admin.name) || (via === 'system' ? 'system' : null),
    reason: trimmedReason || undefined,
    overrode,
    via,
    zenoti: zenotiOutcome?.status || (spec.zenoti ? 'not-required' : null),
  };
  booking.statusLog.push(entry);

  // This service owns the Zenoti call for the action (the model's status hook
  // can only guess from the resulting status, which cannot express an undo).
  booking.$locals.skipZenotiWrite = true;
  await booking.save();
  await applyPackageSessionSideEffect(booking, action, { now, admin });
  if (zenotiOutcome?.status === 'synced') {
    try {
      await require('./zenotiAppointmentSyncService').refreshAppointment(booking._id);
    } catch (_) { /* the frequent inbound poll remains the recovery path */ }
  }
  try { require('./socketService').emitBookingUpdate(booking._id, action); } catch (_) { /* optional live UI */ }
  return booking;
}

/**
 * Actions after which the session row must be re-stamped with the slot the
 * desk actually settled on. Confirming is the obvious one; a reschedule moves
 * the appointment, and the session has to move with it.
 */
const SESSION_SCHEDULE_ACTIONS = new Set(['confirm', 'reschedule']);

/** Keep the package ledger aligned with the appointment lifecycle. */
async function applyPackageSessionSideEffect(booking, action, { now, admin }) {
  if (!booking.packageAssignmentId || !booking.packageSessionId) return;
  const name = String(action || '');
  const reschedules = SESSION_SCHEDULE_ACTIONS.has(name) || name.startsWith('reschedule');
  if (!reschedules
    && !['complete', 'undo_complete', 'cancel', 'no_show', 'undo_cancel', 'undo_no_show'].includes(action)) return;
  const PackageAssignment = require('../models/PackageAssignment');
  const assignment = await PackageAssignment.findById(booking.packageAssignmentId);
  const session = assignment?.sessions?.id(booking.packageSessionId);
  if (!assignment || !session) return;
  const rules = require('../utils/packageRules');

  /*
   * The session row learns when it is.
   *
   * raiseSessionBooking stamps the guest's requested day and slot; the desk's
   * confirmation (or a reschedule) is what fixes the real one. Without this the
   * app kept showing a confirmed package session as "Awaiting confirmation"
   * with no date, because the row still carried the request rather than the
   * appointment. Read from the booking's confirmed fields so the two can never
   * disagree — and never from a raw ISO string: these are Asia/Kolkata clinic
   * days (utils/bookingTime).
   */
  if (booking.confirmedDate) {
    session.scheduledDate = clinicDayStart(booking.confirmedDate) || booking.confirmedDate;
  }
  if (booking.confirmedTime) session.scheduledTime = booking.confirmedTime;

  if (reschedules) {
    // Confirming or moving an appointment does not touch the ledger — the
    // session stays Booked against its appointment. The stamp above is the
    // whole job.
    if (session.status === 'Scheduled' && booking.status !== 'Cancelled') {
      session.status = 'Booked';
      session.bookingId = booking._id;
    }
  } else if (action === 'complete') {
    session.status = 'Completed';
    session.completedAt = now;
    const already = (assignment.redemptions || []).some((entry) =>
      !entry.reversed && String(entry.sessionId) === String(session._id));
    if (!already) rules.recordRedemption(assignment, {
      serviceId: session.serviceId,
      serviceName: session.serviceName,
      sessionId: session._id,
      bookingId: booking._id,
      branchId: booking.branchId,
      byName: admin?.name || 'Appointment completion',
    });
  } else if (action === 'undo_complete') {
    session.status = 'Booked';
    session.completedAt = null;
    rules.reverseRedemption(assignment, { sessionId: session._id });
    if (assignment.status === 'Completed') assignment.status = 'Active';
  } else if (action === 'cancel' || action === 'no_show') {
    session.status = 'Scheduled';
    session.completedAt = null;
    session.bookingId = null;
  } else {
    session.status = 'Booked';
    session.bookingId = booking._id;
  }

  const balances = assignment.serviceBalances();
  assignment.usageTracking.totalSessions = balances.reduce((sum, row) => sum + row.entitled, 0);
  assignment.usageTracking.usedSessions = balances.reduce((sum, row) => sum + row.used, 0);
  assignment.usageTracking.remainingSessions = balances.reduce((sum, row) => sum + row.balance, 0);
  assignment.checkCompletion();
  assignment.$locals.skipZenotiWrite = true;
  await assignment.save();
}

/**
 * The bookkeeping each transition implies — arrival/departure stamps, session
 * duration, the clinical stage, and unwinding them again on an undo.
 */
function applySideEffects(booking, action, { to, now, admin, reason }) {
  const stage = (value) => { if (booking.consultationStage !== value) booking.consultationStage = value; };

  switch (action) {
    case 'confirm':
      if (!booking.confirmedDate) booking.confirmedDate = booking.preferredDate;
      if (!booking.confirmedTime) booking.confirmedTime = booking.slotTime || (booking.preferredTimeSlots || [])[0];
      booking.rescheduleRejected = false;
      stage('confirmed');
      break;

    case 'check_in':
      booking.checkInTime = now;
      booking.cancellationReason = undefined;
      stage('checked_in');
      break;

    case 'undo_check_in':
      booking.checkInTime = undefined;
      stage('confirmed');
      break;

    case 'start':
      // The arrival stamp is the check-in; starting the service does not move
      // it. Zenoti keeps the same distinction (checked_in vs progress=1).
      if (!booking.checkInTime) booking.checkInTime = now;
      stage('consultation_started');
      break;

    case 'undo_start':
      stage('checked_in');
      break;

    case 'complete':
      booking.checkOutTime = now;
      if (booking.checkInTime) {
        booking.sessionDuration = Math.max(0, Math.round((now - booking.checkInTime) / 60_000));
      }
      require('../utils/guestStats').touchLastVisit(booking.userId, now);
      // Signing may already have moved the visit on (prescribed, follow-up due);
      // checking out afterwards must not pull it back to "completed".
      if (!['prescription_created', 'treatment_recommended', 'follow_up_required', 'no_follow_up']
        .includes(booking.consultationStage || '')) stage('consultation_completed');
      break;

    case 'undo_complete':
      booking.checkOutTime = undefined;
      booking.sessionDuration = undefined;
      if (['consultation_completed', 'prescription_created', 'treatment_recommended', 'follow_up_required', 'no_follow_up']
        .includes(booking.consultationStage || '')) stage('consultation_started');
      break;

    case 'no_show':
      booking.cancellationReason = reason || booking.cancellationReason;
      break;

    case 'undo_no_show':
      booking.cancellationReason = undefined;
      break;

    case 'cancel':
      booking.cancellationReason = reason || 'Cancelled at reception';
      booking.cancelledAt = now;
      break;

    case 'undo_cancel':
      booking.cancellationReason = undefined;
      booking.cancelledAt = undefined;
      break;

    default:
      break;
  }

  if (admin && ['check_in', 'start', 'complete'].includes(action) && !booking.therapistName && admin.role === 'therapist') {
    booking.therapistId = admin._id;
    booking.therapistName = admin.name;
  }
}

/**
 * Send the action to Zenoti, then read the appointment back so the panel shows
 * what Zenoti actually holds rather than what we hoped it would.
 *
 * Best-effort by design: the guest is standing at the desk and the visit must
 * be recorded here whatever the CRM does. The outcome lands on the statusLog
 * entry so the failure is visible instead of silent.
 */
async function pushToZenoti(bookingId, action, zenotiAction) {
  const write = require('./zenotiWriteService');
  let outcome = { status: null, error: null };
  try {
    if (!zenotiAction) {
      outcome = { status: 'skipped', error: 'Zenoti has no equivalent for this action.' };
    } else {
      outcome = await write.pushLifecycleAction(bookingId, zenotiAction);
    }
  } catch (error) {
    outcome = { status: 'failed', error: error.message };
    logger.error('Zenoti lifecycle push failed', { bookingId: String(bookingId), action, error: error.message });
  }

  // Stamp the outcome onto the log entry this action created.
  try {
    await Booking.updateOne(
      { _id: bookingId },
      { $set: { 'statusLog.$[last].zenoti': outcome.status, 'statusLog.$[last].zenotiError': outcome.error || null } },
      { arrayFilters: [{ 'last.action': action }], timestamps: false },
    );
  } catch (_) { /* the log stamp is a nicety, never a failure path */ }

  // Pull Zenoti's own view back so both sides agree immediately rather than at
  // the next two-minute poll — this is what keeps the Zenoti mobile app and
  // our panel in step during a live clinic day.
  if (outcome.status === 'synced') {
    try {
      await require('./zenotiAppointmentSyncService').refreshAppointment(bookingId);
    } catch (_) { /* the scheduled poll will catch up */ }
  }

  try {
    require('./socketService').emitBookingUpdate(bookingId, action);
  } catch (_) { /* sockets are a live convenience, not the record */ }

  return outcome;
}

module.exports = {
  ACTIONS,
  EARLY_MINUTES,
  LATE_MINUTES,
  LifecycleError,
  apply,
  availableActions,
  checkInWindow,
  lifecycleState,
};

/**
 * Record a status change made by an older bespoke path (confirm, cancel,
 * no-show, reschedule) on the same trail the lifecycle actions write to, so
 * the booking's history reads as one story rather than two.
 *
 * Does not save — the caller is mid-transaction and saves once.
 */
function logStatus(booking, { action, from, to, admin = null, reason = '', via = 'panel', overrode = false }) {
  booking.statusLog = booking.statusLog || [];
  booking.statusLog.push({
    action,
    from: from ?? null,
    to: to ?? booking.status,
    at: new Date(),
    by: admin && admin._id ? admin._id : null,
    byName: (admin && admin.name) || (via === 'system' ? 'system' : null),
    reason: String(reason || '').trim() || undefined,
    overrode,
    via,
    zenoti: null,
  });
}

module.exports.logStatus = logStatus;

/*
 * Exported so the bespoke desk paths can keep a package session in step too.
 *
 * confirmBooking and rescheduleBookingAdmin (controllers/bookingController.js)
 * do NOT go through apply() — they set the slot themselves and only log the
 * status — so neither reaches the side-effect above. They are the two moments a
 * package session actually learns its real date, so they should call this with
 * 'confirm' / 'reschedule' after saving the booking.
 */
module.exports.applyPackageSessionSideEffect = applyPackageSessionSideEffect;
