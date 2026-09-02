/**
 * Turn a dermatologist's schedule into the concrete slots a patient can pick.
 *
 * The single place that decides "is 10:30 on the 14th bookable with this
 * dermatologist". Everything else — the app's time picker, the panel calendar,
 * the guard that runs before a payment is captured — asks this, so all three
 * cannot drift apart and offer a slot the others think is gone.
 *
 * A slot is bookable when all of these hold:
 *   · the schedule is active and the date is inside the booking horizon
 *   · the date falls in a weekly range, or an override supplies ranges
 *   · no override marks the date unavailable
 *   · the slot start is far enough ahead to clear the lead time
 *   · no live booking already holds it
 *
 * Booked slots are returned rather than dropped. The caller decides whether to
 * grey them out or hide them, and the panel needs to see them either way.
 */
const Booking = require('../models/Booking');
const DermatologistSchedule = require('../models/DermatologistSchedule');
const { SESSION_SLOT_MINUTES } = require('../config/scheduling');
const {
  clinicDateKey,
  clinicDateTime,
  parseClockMinutes,
} = require('./bookingTime');

const { toMinutes, toHHMM } = DermatologistSchedule;

/**
 * Statuses that still occupy the diary — these must stay in step with
 * `Booking.status`'s enum. Cancelled and No Show release the slot back to the
 * pool; Completed keeps it, so a slot finished earlier today is not offered
 * again to somebody else.
 */
const LIVE_STATUSES = [
  'Awaiting Confirmation',
  'Confirmed',
  'Rescheduled',
  'In Progress',
  'Completed',
];

/** "2026-08-14" for a Date, in local clinic time — never toISOString(). */
function dateKey(date) {
  return clinicDateKey(date);
}

/** The UTC instant corresponding to clinic-local midnight for a date key. */
function fromKey(key) {
  return clinicDateTime(key, '00:00');
}

function addDaysToKey(key, amount) {
  const [y, m, d] = String(key).split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d));
  next.setUTCDate(next.getUTCDate() + amount);
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}

/** Weekday for the written clinic date, independent of the server timezone. */
function weekdayForKey(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** "10:30" → "10:30 AM", for anything that renders the slot directly. */
function label(hhmm) {
  const mins = toMinutes(hhmm);
  if (mins === null) return hhmm;
  const h24 = Math.floor(mins / 60);
  const m = mins % 60;
  const suffix = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

/**
 * The ranges that apply on one date, and where they came from.
 *
 * An override always beats the weekly pattern — that is the whole point of
 * one. An override that carries no ranges and is not marked unavailable is
 * treated as a note on an otherwise normal day, so the weekly pattern still
 * stands rather than the day silently emptying.
 */
function rangesFor(schedule, key) {
  const override = (schedule.overrides || []).find((o) => o.date === key);

  if (override?.unavailable) {
    return { ranges: [], branchId: override.branchId ?? null, source: 'override', note: override.note || '' };
  }
  if (override?.ranges?.length) {
    return { ranges: override.ranges, branchId: override.branchId ?? null, source: 'override', note: override.note || '' };
  }

  const day = weekdayForKey(key);
  const weekly = (schedule.weekly || []).filter((w) => w.day === day && w.ranges?.length);
  if (!weekly.length) {
    return { ranges: [], branchId: null, source: 'weekly', note: override?.note || '' };
  }

  return {
    ranges: weekly.flatMap((w) => w.ranges),
    branchId: weekly[0].branchId ?? null,
    source: 'weekly',
    note: override?.note || '',
    // Kept so a branch filter can tell which centre each range belongs to.
    perBranch: weekly.map((w) => ({ branchId: w.branchId ?? null, ranges: w.ranges })),
  };
}

/** Cut a range into starts of `slotMinutes`, dropping any tail that won't fit. */
function expand(range, slotMinutes) {
  const start = toMinutes(range.start);
  const end = toMinutes(range.end);
  if (start === null || end === null || end <= start) return [];

  const out = [];
  for (let m = start; m + slotMinutes <= end; m += slotMinutes) out.push(m);
  return out;
}


/**
 * A dermatologist can only be booked while the centre is open. Clamp the
 * working ranges to the branch's hours for that day; a closure wipes them.
 * Ranges without a branch are clamped to the requested branch (if any).
 */
const branchCache = new Map();
async function branchDoc(branchId) {
  if (!branchId) return null;
  const k = String(branchId);
  const hit = branchCache.get(k);
  if (hit && Date.now() - hit.at < 60 * 1000) return hit.doc;
  const Branch = require('../models/Branch');
  const doc = await Branch.findById(branchId);
  branchCache.set(k, { at: Date.now(), doc });
  return doc;
}
async function clampToBranch(ranges, branchId, key) {
  const b = await branchDoc(branchId);
  if (!b) return { ranges, closed: null };
  const closed = b.closureFor(key);
  if (closed) return { ranges: [], closed };
  const h = b.hoursFor(key);
  if (!h) return { ranges: [], closed: { closed: true, reason: 'Closed' } };
  const open = toMinutes(h.open); const close = toMinutes(h.close);
  const out = ranges.map((r) => {
    const s = Math.max(toMinutes(r.start), open); const e = Math.min(toMinutes(r.end), close);
    return e > s ? { ...r, start: toHHMM(s), end: toHHMM(e) } : null;
  }).filter(Boolean);
  return { ranges: out, closed: null };
}

/** Starts already held by a live booking, as minutes from midnight. */
async function bookedTimes(doctorId, key, { excludeBookingId = null } = {}) {
  const day = fromKey(key);
  const next = fromKey(addDaysToKey(key, 1));

  const rows = await Booking.find({
    specialistId: doctorId,
    preferredDate: { $gte: day, $lt: next },
    status: { $in: LIVE_STATUSES },
    // A reschedule re-checks the target slot; the booking being moved must not
    // count itself as the conflict.
    ...(excludeBookingId ? { _id: { $ne: excludeBookingId } } : {}),
  })
    .select('slotTime confirmedTime preferredTimeSlots')
    .lean();

  const taken = new Set();
  const hold = (value) => {
    const minutes = parseClockMinutes(value);
    if (minutes !== null) taken.add(minutes);
  };
  rows.forEach((b) => {
    // `slotTime` is what the new flow writes. The other two are read so
    // appointments made before this existed still block their slot instead of
    // quietly reopening it to a second patient.
    if (b.slotTime) hold(b.slotTime);
    else if (b.confirmedTime) hold(b.confirmedTime);
    else (b.preferredTimeSlots || []).forEach(hold);
  });
  return taken;
}

/** Two one-hour sessions conflict whenever their occupied ranges overlap. */
function overlapsHeldSession(taken, start, duration = SESSION_SLOT_MINUTES) {
  return [...taken].some(
    (heldStart) => start < heldStart + duration && heldStart < start + duration,
  );
}

/**
 * Every slot on one date, each flagged bookable or not and why.
 *
 * `branchId` narrows to the ranges sat at that centre; passing nothing returns
 * the whole day.
 */
async function slotsForDate(doctorId, key, { branchId = null, now = new Date(), excludeBookingId = null } = {}) {
  const schedule = await DermatologistSchedule.findOne({ doctorId }).lean();

  if (!schedule) return { date: key, configured: false, slots: [], reason: 'not-configured' };
  if (!schedule.isActive) return { date: key, configured: true, slots: [], reason: 'inactive' };

  // An unlisted (or deleted) dermatologist is not bookable, even by a client
  // that still holds their id — the roster check alone cannot guarantee that.
  const DoctorModel = require('../models/Doctor');
  const who = await DoctorModel.findOne({ doctorId }).select('isActive').lean();
  if (!who || who.isActive === false) {
    return { date: key, configured: true, slots: [], reason: 'doctor-inactive' };
  }

  const todayKey = dateKey(now);
  const horizonEnd = fromKey(addDaysToKey(todayKey, schedule.horizonDays ?? 60));
  const day = fromKey(key);
  const todayStart = fromKey(todayKey);

  if (day < todayStart) return { date: key, configured: true, slots: [], reason: 'past' };
  if (day > horizonEnd) return { date: key, configured: true, slots: [], reason: 'beyond-horizon' };

  const resolved = rangesFor(schedule, key);
  if (!resolved.ranges.length) {
    return { date: key, configured: true, slots: [], reason: 'not-working', note: resolved.note };
  }

  // Narrow to one centre when asked. A range with no branch is treated as
  // available everywhere, which is what `branchId: null` means on the model.
  let ranges = resolved.ranges;
  if (branchId && resolved.perBranch) {
    ranges = resolved.perBranch
      .filter((p) => !p.branchId || String(p.branchId) === String(branchId))
      .flatMap((p) => p.ranges);
  } else if (branchId && resolved.source === 'override' && resolved.branchId) {
    ranges = String(resolved.branchId) === String(branchId) ? ranges : [];
  }
  if (!ranges.length) {
    return { date: key, configured: true, slots: [], reason: 'not-at-this-centre', note: resolved.note };
  }
  {
    const clamped = await clampToBranch(ranges, branchId || (resolved.perBranch && resolved.perBranch[0] && resolved.perBranch[0].branchId), key);
    if (clamped.closed) return { date: key, configured: true, slots: [], reason: 'centre-closed', note: clamped.closed.reason };
    ranges = clamped.ranges;
    if (!ranges.length) return { date: key, configured: true, slots: [], reason: 'outside-centre-hours' };
  }

  // Existing records may still carry the former 30-minute setting. The
  // platform policy is authoritative, so reads become hourly immediately.
  const slotMinutes = SESSION_SLOT_MINUTES;
  const earliest = new Date(now.getTime() + (schedule.leadTimeHours ?? 0) * 3600 * 1000);
  const taken = await bookedTimes(doctorId, key, { excludeBookingId });

  // A Set, because two weekly rows at different centres can overlap and would
  // otherwise offer the same time twice.
  const starts = [...new Set(ranges.flatMap((r) => expand(r, slotMinutes)))].sort((a, b) => a - b);

  const slots = starts.map((minutes) => {
    const at = clinicDateTime(key, toHHMM(minutes));

    const time = toHHMM(minutes);
    const booked = overlapsHeldSession(taken, minutes, slotMinutes);
    const tooSoon = at < earliest;

    return {
      time,
      label: label(time),
      minutes,
      booked,
      tooSoon,
      available: !booked && !tooSoon,
    };
  });

  return {
    date: key,
    configured: true,
    slotMinutes,
    note: resolved.note,
    source: resolved.source,
    slots,
  };
}

/**
 * Day-level summary across a range, for painting the calendar.
 *
 * One schedule read and one booking query for the whole span rather than per
 * day — a 60-day calendar was otherwise 60 round trips before it could render.
 */
async function availabilityRange(doctorId, fromKeyStr, toKeyStr, { branchId = null, now = new Date() } = {}) {
  const schedule = await DermatologistSchedule.findOne({ doctorId }).lean();
  if (!schedule) return { configured: false, days: [] };

  const from = fromKey(fromKeyStr);
  const to = fromKey(toKeyStr);

  // Same gate as slotsForDate: an unlisted dermatologist paints a fully closed
  // calendar rather than a bookable one.
  const DoctorModel = require('../models/Doctor');
  const who = await DoctorModel.findOne({ doctorId }).select('isActive').lean();
  if (!who || who.isActive === false) {
    const days = [];
    for (let d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
      days.push({ date: dateKey(d), open: false, total: 0, free: 0 });
    }
    return { configured: true, slotMinutes: SESSION_SLOT_MINUTES, days };
  }
  const next = fromKey(addDaysToKey(toKeyStr, 1));

  const rows = await Booking.find({
    specialistId: doctorId,
    preferredDate: { $gte: from, $lt: next },
    status: { $in: LIVE_STATUSES },
  })
    .select('slotTime confirmedTime preferredTimeSlots preferredDate')
    .lean();

  const takenByDate = new Map();
  rows.forEach((b) => {
    const key = dateKey(new Date(b.preferredDate));
    if (!takenByDate.has(key)) takenByDate.set(key, new Set());
    const set = takenByDate.get(key);
    const hold = (value) => {
      const minutes = parseClockMinutes(value);
      if (minutes !== null) set.add(minutes);
    };
    if (b.slotTime) hold(b.slotTime);
    else if (b.confirmedTime) hold(b.confirmedTime);
    else (b.preferredTimeSlots || []).forEach(hold);
  });

  const slotMinutes = SESSION_SLOT_MINUTES;
  const earliest = new Date(now.getTime() + (schedule.leadTimeHours ?? 0) * 3600 * 1000);
  const todayKey = dateKey(now);
  const todayStart = fromKey(todayKey);
  const horizonEnd = fromKey(addDaysToKey(todayKey, schedule.horizonDays ?? 60));

  const days = [];
  for (let d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = dateKey(d);
    const day = new Date(d);

    if (!schedule.isActive || day < todayStart || day > horizonEnd) {
      days.push({ date: key, open: false, total: 0, free: 0 });
      continue;
    }

    const resolved = rangesFor(schedule, key);
    let ranges = resolved.ranges;
    if (branchId && resolved.perBranch) {
      ranges = resolved.perBranch
        .filter((p) => !p.branchId || String(p.branchId) === String(branchId))
        .flatMap((p) => p.ranges);
    }

    if (ranges.length) {
      const clamped = await clampToBranch(ranges, branchId || (resolved.perBranch && resolved.perBranch[0] && resolved.perBranch[0].branchId), key);
      ranges = clamped.ranges;
      if (clamped.closed) { days.push({ date: key, open: false, total: 0, free: 0, note: clamped.closed.reason }); continue; }
    }
    if (!ranges.length) {
      days.push({ date: key, open: false, total: 0, free: 0, note: resolved.note });
      continue;
    }

    const starts = [...new Set(ranges.flatMap((r) => expand(r, slotMinutes)))];
    const taken = takenByDate.get(key) || new Set();

    let free = 0;
    starts.forEach((minutes) => {
      const at = clinicDateTime(key, toHHMM(minutes));
      if (!overlapsHeldSession(taken, minutes, slotMinutes) && at >= earliest) free += 1;
    });

    days.push({ date: key, open: free > 0, total: starts.length, free, note: resolved.note });
  }

  return { configured: true, slotMinutes, days };
}

/**
 * Re-check one slot immediately before money is taken.
 *
 * The picker's answer is already stale by the time a payment returns — someone
 * else may have taken the slot while the patient was in the Razorpay sheet.
 */
async function isSlotBookable(doctorId, key, time, { branchId = null, now = new Date(), excludeBookingId = null } = {}) {
  const { slots, configured, reason } = await slotsForDate(doctorId, key, { branchId, now, excludeBookingId });
  if (!configured) return { ok: false, reason: reason || 'not-configured' };

  const slot = slots.find((s) => s.time === time);
  if (!slot) return { ok: false, reason: 'no-such-slot' };
  if (slot.booked) return { ok: false, reason: 'already-booked' };
  if (slot.tooSoon) return { ok: false, reason: 'too-soon' };
  return { ok: true, slot };
}

/* -------------------------------------------------------------------------
 * "Any available dermatologist"
 *
 * The patient picks the date and time first and we find who can see them,
 * rather than making them choose a name before they know when that person is
 * free. So these answer across the whole team instead of one calendar.
 * ---------------------------------------------------------------------- */

/** Active dermatologists, optionally narrowed to one centre. */
async function team(branchName = null) {
  const Doctor = require('../models/Doctor');
  const query = { isActive: true };
  const rows = await Doctor.find(query).select('doctorId name tier availableCentres').lean();
  if (!branchName) return rows;

  // A dermatologist with no centres listed is treated as available anywhere,
  // matching how `availableCentres` is read everywhere else.
  return rows.filter(
    (d) => !d.availableCentres?.length || d.availableCentres.includes(branchName),
  );
}

const sameBranchName = (left, right) =>
  String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();

/**
 * Every clinic where each free dermatologist can take the requested slot.
 *
 * The time-first flow is deliberately clinic-wide. Returning the matching
 * clinic with the doctor prevents the client from guessing a branch after the
 * slot was selected and then discovering at payment that the doctor was free
 * somewhere else.
 */
async function whoIsFreeWithBranches(
  key,
  time,
  { branchId = null, branchName = null, now = new Date() } = {},
) {
  const Branch = require('../models/Branch');
  const doctors = await team();
  if (!doctors.length) return [];

  const branchQuery = { isActive: true };
  if (branchId) branchQuery._id = branchId;
  const branches = await Branch.find(branchQuery).select('_id name').lean();
  const requestedBranches = branchName
    ? branches.filter((branch) => sameBranchName(branch.name, branchName))
    : branches;

  const perDoctor = await Promise.all(
    doctors.map(async (doctor) => {
      const assigned = requestedBranches.filter(
        (branch) =>
          !doctor.availableCentres?.length
          || doctor.availableCentres.some((name) => sameBranchName(name, branch.name)),
      );

      const checks = await Promise.all(
        assigned.map(async (branch) => ({
          branch,
          check: await isSlotBookable(doctor.doctorId, key, time, {
            branchId: branch._id,
            now,
          }),
        })),
      );

      return checks
        .filter(({ check }) => check.ok)
        .map(({ branch }) => ({
          doctorId: doctor.doctorId,
          branchId: String(branch._id),
          branchName: branch.name,
        }));
    }),
  );

  return perDoctor.flat();
}

/**
 * Every time anyone on the team can offer on one date, merged.
 *
 * A time is offered if at least one dermatologist has it free. `freeWith`
 * carries who, so the screen that picks the person afterwards does not have to
 * ask again.
 */
async function anySlotsForDate(key, { branchId = null, branchName = null, now = new Date() } = {}) {
  const doctors = await team(branchName);
  if (!doctors.length) return { date: key, configured: false, slots: [], reason: 'no-dermatologists' };

  const perDoctor = await Promise.all(
    doctors.map((d) => slotsForDate(d.doctorId, key, { branchId, now })),
  );

  const byTime = new Map();
  perDoctor.forEach((result, i) => {
    result.slots.forEach((s) => {
      const entry = byTime.get(s.time) || {
        time: s.time,
        label: s.label,
        minutes: s.minutes,
        freeWith: [],
        // Starts "too soon" and flips false as soon as any dermatologist
        // offers it within the lead time — otherwise one person's longer lead
        // time would grey the slot out for the whole team.
        tooSoon: true,
      };
      if (s.available) {
        entry.freeWith.push(doctors[i].doctorId);
        entry.tooSoon = false;
      } else if (!s.tooSoon) {
        entry.tooSoon = false;
      }
      byTime.set(s.time, entry);
    });
  });

  const slots = [...byTime.values()]
    .sort((a, b) => a.minutes - b.minutes)
    .map((s) => ({
      ...s,
      available: s.freeWith.length > 0,
      // In this mode "booked" means nobody is left at that time, which is what
      // the patient actually needs to know.
      booked: s.freeWith.length === 0 && !s.tooSoon,
    }));

  return { date: key, configured: true, slotMinutes: SESSION_SLOT_MINUTES, slots };
}

/** Day states across a range for the whole team — open if anyone is free. */
async function anyAvailabilityRange(fromKeyStr, toKeyStr, { branchId = null, branchName = null, now = new Date() } = {}) {
  const doctors = await team(branchName);
  if (!doctors.length) return { configured: false, days: [] };

  const perDoctor = await Promise.all(
    doctors.map((d) => availabilityRange(d.doctorId, fromKeyStr, toKeyStr, { branchId, now })),
  );

  const merged = new Map();
  perDoctor.forEach((r) => {
    (r.days || []).forEach((d) => {
      const cur = merged.get(d.date) || { date: d.date, open: false, total: 0, free: 0 };
      cur.open = cur.open || d.open;
      cur.total += d.total;
      cur.free += d.free;
      merged.set(d.date, cur);
    });
  });

  return {
    configured: true,
    slotMinutes: SESSION_SLOT_MINUTES,
    days: [...merged.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

/** Who can take this exact date and time. */
async function whoIsFree(key, time, { branchId = null, branchName = null, now = new Date() } = {}) {
  const matches = await whoIsFreeWithBranches(key, time, {
    branchId,
    branchName,
    now,
  });
  return [...new Set(matches.map((match) => match.doctorId))];
}

module.exports = {
  LIVE_STATUSES,
  anySlotsForDate,
  anyAvailabilityRange,
  whoIsFree,
  whoIsFreeWithBranches,
  dateKey,
  fromKey,
  label,
  slotsForDate,
  availabilityRange,
  isSlotBookable,
};
