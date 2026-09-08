/**
 * Live, fail-closed availability backed by Zenoti.
 *
 * Zenoti is the schedule of record. Local schedules are retained only as an
 * audit/migration mirror; no patient or staff booking decision is made from
 * them. A very short promise cache coalesces identical screen requests so the
 * date picker, slot picker and doctor picker do not trip Zenoti's rate limit.
 */
const Booking = require('../models/Booking');
const Branch = require('../models/Branch');
const Doctor = require('../models/Doctor');
const ZenotiPractitioner = require('../models/ZenotiPractitioner');
const zenoti = require('./zenotiService');
const { CENTERS } = require('../config/zenoti');
const { SESSION_SLOT_MINUTES } = require('../config/scheduling');
const {
  addClinicDays,
  clinicDayEnd,
  clinicDayStart,
  clinicDateKey,
  clinicDateTime,
  parseClockMinutes,
} = require('../utils/bookingTime');
const { LIVE } = require('../utils/bookingStatuses');

const CACHE_MS = Math.max(5_000, Number(process.env.ZENOTI_AVAILABILITY_CACHE_MS) || 15_000);
const cache = new Map();

class ZenotiAvailabilityError extends Error {
  constructor(message, code = 'ZENOTI_AVAILABILITY_UNAVAILABLE', status = 503) {
    super(message);
    this.name = 'ZenotiAvailabilityError';
    this.code = code;
    this.status = status;
  }
}

function cached(key, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.promise;
  const promise = Promise.resolve().then(load).catch((error) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, { at: Date.now(), promise });
  return promise;
}

const norm = (value) => String(value || '').trim().toLowerCase();
const toHHMM = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const label = (time) => {
  const minutes = parseClockMinutes(time);
  if (minutes === null) return time;
  const hour = Math.floor(minutes / 60);
  return `${hour % 12 || 12}:${String(minutes % 60).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
};
const clock = (value) => {
  const text = String(value || '');
  const match = text.match(/(?:T|\s)(\d{1,2}:\d{2})/) || text.match(/^(\d{1,2}:\d{2})/);
  return match ? match[1].padStart(5, '0') : null;
};
const writtenDate = (value) => {
  const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : clinicDateKey(value);
};

function centerForBranch(branch) {
  if (!branch) throw new ZenotiAvailabilityError('Clinic not found.', 'BRANCH_NOT_FOUND', 404);
  const explicit = norm(branch.zenotiCenterId);
  if (explicit && CENTERS[explicit]?.isClinic) return explicit;
  const exact = Object.entries(CENTERS).find(([, center]) =>
    center.isClinic && norm(center.branchName) === norm(branch.name));
  if (exact) return exact[0];
  throw new ZenotiAvailabilityError(
    `"${branch.name}" is not mapped to a Zenoti clinic. Configure zenotiCenterId before taking bookings.`,
    'ZENOTI_CENTER_UNMAPPED',
    409,
  );
}

async function branchById(branchId) {
  if (!branchId) return null;
  const branch = await Branch.findOne({ _id: branchId, isActive: true }).select('_id name zenotiCenterId').lean();
  if (!branch) throw new ZenotiAvailabilityError('Clinic not found or inactive.', 'BRANCH_NOT_FOUND', 404);
  return branch;
}

/**
 * Where this doctor can actually be booked.
 *
 * Zenoti is the schedule of record, so the centres come from the doctor's
 * Zenoti employee links — NOT from `Doctor.availableCentres`, which is typed by
 * hand in the panel and had drifted for seven of nine active dermatologists on
 * 2026-09-08. Six of those were listed at FEWER centres than Zenoti has them
 * at, so real bookable hours were hidden from guests: Rickson, Spoorthy and
 * Madhurya were rostered at Financial District and offered only at Jubilee
 * Hills; Meghana was rostered at all three and offered at one. The seventh
 * (Janaki) was the mirror image — offered at three, present in Zenoti at one —
 * which is what threw ZENOTI_PRACTITIONER_UNMAPPED into the app.
 *
 * Deriving it from the link makes the two agree by construction and self-heals
 * when the clinic changes a roster in Zenoti. `availableCentres` is still the
 * fallback for a doctor with no Zenoti link at all, so nothing regresses for an
 * unlinked (local-only) dermatologist.
 */
async function candidateBranches(doctor, branchId = null, branchName = null) {
  if (branchId) return [await branchById(branchId)];
  const query = { isActive: true, centreType: 'clinic' };
  if (branchName) query.name = new RegExp(`^${String(branchName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  const rows = await Branch.find(query).select('_id name zenotiCenterId').sort({ displayOrder: 1, name: 1 }).lean();

  const links = doctor?.doctorId
    ? await ZenotiPractitioner.find({ onboardedDoctorId: norm(doctor.doctorId), active: true })
        .select('centerIds').lean()
    : [];
  const linkedCentres = new Set(links.flatMap((l) => (l.centerIds || []).map(norm)));
  if (linkedCentres.size) {
    return rows.filter((branch) => linkedCentres.has(norm(branch.zenotiCenterId)));
  }
  // No Zenoti link — fall back to what the panel says.
  return rows.filter((branch) => !doctor?.availableCentres?.length
    || doctor.availableCentres.some((name) => norm(name) === norm(branch.name)));
}

async function practitionerFor(doctorId, centerId) {
  const rows = await ZenotiPractitioner.find({
    onboardedDoctorId: norm(doctorId),
    active: true,
    centerIds: norm(centerId),
  }).select('zenotiEmployeeId name centerIds').lean();
  if (!rows.length) {
    throw new ZenotiAvailabilityError(
      `Doctor ${doctorId} is not linked to a Zenoti employee at this clinic.`,
      'ZENOTI_PRACTITIONER_UNMAPPED',
      409,
    );
  }
  if (rows.length > 1) {
    throw new ZenotiAvailabilityError(
      `Doctor ${doctorId} has ${rows.length} active Zenoti employee links at this clinic. Resolve the duplicate before booking.`,
      'AMBIGUOUS_ZENOTI_PRACTITIONER',
      409,
    );
  }
  return rows[0];
}

function workingRanges(rows, employeeId, date) {
  const row = (rows || []).find((item) => norm(item.employeeId) === norm(employeeId));
  return (row?.shifts || []).filter((shift) =>
    writtenDate(shift.date) === date && Number(shift.status) === 0)
    .map((shift) => ({ start: clock(shift.start), end: clock(shift.end), status: shift.status }))
    .filter((range) => parseClockMinutes(range.start) !== null
      && parseClockMinutes(range.end) !== null
      && parseClockMinutes(range.end) > parseClockMinutes(range.start));
}

const activeAppointment = (appointment) => {
  const status = norm(appointment.status);
  return !['-2', '-1', '21', 'no show', 'noshow'].includes(status) && !/cancel|void/.test(status);
};

function interval(row) {
  const start = parseClockMinutes(clock(row.startTime));
  const end = parseClockMinutes(clock(row.endTime));
  return start === null ? null : { start, end: end !== null && end > start ? end : start + SESSION_SLOT_MINUTES };
}

const overlaps = (ranges, start, end) => ranges.some((range) => start < range.end && range.start < end);

async function centerSchedule(centerId, from, to) {
  return cached(`schedule:${centerId}:${from}:${to}`, () => zenoti.getCenterEmployeeSchedules(centerId, { from, to }));
}

async function centerDiary(centerId, date) {
  return cached(`diary:${centerId}:${date}`, () => zenoti.getCenterDiary(centerId, { from: date, to: date, includeCancelled: true }));
}

/**
 * Zenoti's diary endpoint accepts at most seven days; compose longer calendars
 * from parallel pages.
 *
 * These used to run one after another, so a month calendar was five round trips
 * end to end — and each one also waited its turn in the shared rate limiter.
 * They are independent reads, so they go together: measured 3.9s → 1.4s for a
 * 30-day month even with no competing traffic.
 */
async function centerDiaryRange(centerId, from, to) {
  return cached(`diary-range:${centerId}:${from}:${to}`, async () => {
    const windows = [];
    for (let start = from; start && start <= to; start = addClinicDays(start, 7)) {
      let end = addClinicDays(start, 6);
      if (!end || end > to) end = to;
      windows.push([start, end]);
    }
    const pages = await Promise.all(windows.map(([start, end]) =>
      zenoti.getCenterDiary(centerId, { from: start, to: end, includeCancelled: true })));
    return {
      appointments: pages.flatMap((page) => page.appointments || []),
      blockouts: pages.flatMap((page) => page.blockouts || []),
    };
  });
}

async function localHolds(doctorId, date, excludeBookingId = null) {
  const query = {
    specialistId: norm(doctorId),
    preferredDate: { $gte: clinicDayStart(date), $lte: clinicDayEnd(date) },
    status: { $in: LIVE },
  };
  if (excludeBookingId) query._id = { $ne: excludeBookingId };
  const rows = await Booking.find(query).select('slotTime confirmedTime preferredTimeSlots zenotiAppointmentId').lean();
  return rows.flatMap((booking) => {
    // Zenoti diary already holds synced appointments. Keeping only local-only
    // rows here is what protects paid/awaiting requests before staff confirms.
    if (booking.zenotiAppointmentId) return [];
    const values = booking.slotTime || booking.confirmedTime
      ? [booking.slotTime || booking.confirmedTime]
      : (booking.preferredTimeSlots || []);
    return values.map((time) => parseClockMinutes(time)).filter((value) => value !== null)
      .map((start) => ({ start, end: start + SESSION_SLOT_MINUTES }));
  });
}

/** Local-only awaiting/confirmed holds over a calendar span, grouped by day. */
async function localHoldsRange(doctorId, from, to, excludeBookingId = null) {
  const query = {
    specialistId: norm(doctorId),
    preferredDate: { $gte: clinicDayStart(from), $lte: clinicDayEnd(to) },
    status: { $in: LIVE },
  };
  if (excludeBookingId) query._id = { $ne: excludeBookingId };
  const rows = await Booking.find(query)
    .select('preferredDate slotTime confirmedTime preferredTimeSlots zenotiAppointmentId')
    .lean();
  const byDate = new Map();
  for (const booking of rows) {
    if (booking.zenotiAppointmentId) continue;
    const date = clinicDateKey(booking.preferredDate);
    if (!date) continue;
    const values = booking.slotTime || booking.confirmedTime
      ? [booking.slotTime || booking.confirmedTime]
      : (booking.preferredTimeSlots || []);
    const intervals = values.map((time) => parseClockMinutes(time))
      .filter((value) => value !== null)
      .map((start) => ({ start, end: start + SESSION_SLOT_MINUTES }));
    if (intervals.length) byDate.set(date, [...(byDate.get(date) || []), ...intervals]);
  }
  return byDate;
}

async function doctorSlotsAtBranch(doctor, branch, date, { now = new Date(), excludeBookingId = null } = {}) {
  const centerId = centerForBranch(branch);
  const practitioner = await practitionerFor(doctor.doctorId, centerId);
  const [schedules, diary, holds] = await Promise.all([
    centerSchedule(centerId, date, date),
    centerDiary(centerId, date),
    localHolds(doctor.doctorId, date, excludeBookingId),
  ]);
  const ranges = workingRanges(schedules, practitioner.zenotiEmployeeId, date);
  const employeeId = norm(practitioner.zenotiEmployeeId);
  const busy = [
    ...(diary.appointments || []).filter((row) => norm(row.therapistId) === employeeId && activeAppointment(row)).map(interval),
    ...(diary.blockouts || []).filter((row) => norm(row.therapistId) === employeeId).map(interval),
    ...holds,
  ].filter(Boolean);

  const starts = [...new Set(ranges.flatMap((range) => {
    const out = [];
    const from = parseClockMinutes(range.start);
    const to = parseClockMinutes(range.end);
    for (let at = from; at + SESSION_SLOT_MINUTES <= to; at += SESSION_SLOT_MINUTES) out.push(at);
    return out;
  }))].sort((a, b) => a - b);

  return starts.map((minutes) => {
    const time = toHHMM(minutes);
    const blocked = overlaps(busy, minutes, minutes + SESSION_SLOT_MINUTES);
    const tooSoon = clinicDateTime(date, time) < now;
    return {
      time, label: label(time), minutes,
      booked: blocked,
      blocked,
      tooSoon,
      available: !blocked && !tooSoon,
      branchId: String(branch._id),
      branchName: branch.name,
      zenotiCenterId: centerId,
    };
  });
}

async function slotsForDate(doctorId, date, options = {}) {
  const doctor = await Doctor.findOne({ doctorId: norm(doctorId), isActive: true })
    .select('doctorId name availableCentres onlineBookingEnabled').lean();
  if (!doctor) return { date, configured: true, slots: [], reason: 'doctor-inactive', source: 'zenoti-live' };
  const branches = await candidateBranches(doctor, options.branchId, options.branchName);
  if (!branches.length) return { date, configured: true, slots: [], reason: 'not-at-this-centre', source: 'zenoti-live' };

  /*
   * A centre where this doctor has no Zenoti employee is NOT an error — it is
   * simply a centre they do not work at, and the honest answer is "no times
   * here", not a 409 that blanks the screen.
   *
   * Janaki is listed at three centres in the panel and exists in Zenoti at one,
   * so /dermatologists/janaki-yalamanchili/slots?branchId=<FD|Kondapur> threw
   * ZENOTI_PRACTITIONER_UNMAPPED straight out to the app — a guest who picked
   * her got a broken slot screen rather than an empty one. The clinic-wide
   * endpoint already degraded this way (it collects warnings); the per-doctor
   * one did not.
   *
   * A genuine Zenoti outage still fails loudly: only configuration problems
   * (unmapped / ambiguous link) are downgraded to a warning.
   */
  const CONFIG_CODES = new Set(['ZENOTI_PRACTITIONER_UNMAPPED', 'AMBIGUOUS_ZENOTI_PRACTITIONER']);
  const warnings = [];
  const settled = await Promise.all(branches.map(async (branch) => {
    try {
      return await doctorSlotsAtBranch(doctor, branch, date, options);
    } catch (error) {
      if (!CONFIG_CODES.has(error?.code)) throw error;
      warnings.push({ branchId: String(branch._id), branchName: branch.name, code: error.code, message: error.message });
      return [];
    }
  }));
  const results = settled;
  const byTime = new Map();
  results.flat().forEach((slot) => {
    const existing = byTime.get(slot.time);
    if (!existing) byTime.set(slot.time, { ...slot, freeAt: slot.available ? [{ branchId: slot.branchId, branchName: slot.branchName }] : [] });
    else {
      existing.available = existing.available || slot.available;
      existing.booked = !existing.available;
      existing.blocked = !existing.available;
      if (slot.available) existing.freeAt.push({ branchId: slot.branchId, branchName: slot.branchName });
    }
  });
  return {
    date,
    configured: true,
    source: 'zenoti-live',
    slotMinutes: SESSION_SLOT_MINUTES,
    slots: [...byTime.values()].sort((a, b) => a.minutes - b.minutes),
    // "not-linked" when every candidate centre lacks a Zenoti link, so the
    // panel can say "link this doctor in Zenoti" instead of "not working".
    reason: byTime.size ? null : (warnings.length === branches.length ? 'not-linked' : 'not-working'),
    ...(warnings.length ? { warnings } : {}),
  };
}

async function isSlotBookable(doctorId, date, time, options = {}) {
  const result = await slotsForDate(doctorId, date, options);
  const wanted = parseClockMinutes(time);
  const slot = result.slots.find((item) => item.minutes === wanted);
  if (!slot) return { ok: false, reason: result.reason || 'no-such-slot' };
  if (slot.booked) return { ok: false, reason: 'already-booked' };
  if (slot.tooSoon) return { ok: false, reason: 'too-soon' };
  return { ok: true, slot };
}

async function availabilityRange(doctorId, from, to, options = {}) {
  const doctor = await Doctor.findOne({ doctorId: norm(doctorId), isActive: true })
    .select('doctorId name availableCentres onlineBookingEnabled').lean();
  if (!doctor) return { configured: true, source: 'zenoti-live', slotMinutes: SESSION_SLOT_MINUTES, days: [] };
  const branches = await candidateBranches(doctor, options.branchId, options.branchName);
  const [scheduleSets, holds] = await Promise.all([
    Promise.all(branches.map(async (branch) => {
      const centerId = centerForBranch(branch);
      const practitioner = await practitionerFor(doctor.doctorId, centerId);
      const [rows, diary] = await Promise.all([
        centerSchedule(centerId, from, to),
        centerDiaryRange(centerId, from, to),
      ]);
      return { rows, diary, employeeId: practitioner.zenotiEmployeeId };
    })),
    localHoldsRange(doctor.doctorId, from, to, options.excludeBookingId),
  ]);
  const days = [];
  for (let date = from; date && date <= to; date = addClinicDays(date, 1)) {
    const allStarts = new Set();
    const freeStarts = new Set();
    for (const set of scheduleSets) {
      const employeeId = norm(set.employeeId);
      const busy = [
        ...(set.diary.appointments || []).filter((row) => writtenDate(row.startTime) === date && norm(row.therapistId) === employeeId && activeAppointment(row)).map(interval),
        ...(set.diary.blockouts || []).filter((row) => writtenDate(row.startTime) === date && norm(row.therapistId) === employeeId).map(interval),
        ...(holds.get(date) || []),
      ].filter(Boolean);
      for (const range of workingRanges(set.rows, set.employeeId, date)) {
        for (let at = parseClockMinutes(range.start); at + SESSION_SLOT_MINUTES <= parseClockMinutes(range.end); at += SESSION_SLOT_MINUTES) {
          allStarts.add(at);
          if (!overlaps(busy, at, at + SESSION_SLOT_MINUTES)
            && clinicDateTime(date, toHHMM(at)) >= (options.now || new Date())) freeStarts.add(at);
        }
      }
    }
    days.push({ date, open: freeStarts.size > 0, total: allStarts.size, free: freeStarts.size });
  }
  return { configured: true, source: 'zenoti-live', slotMinutes: SESSION_SLOT_MINUTES, days };
}

async function team() {
  return Doctor.find({ isActive: true, onlineBookingEnabled: { $ne: false } })
    .select('doctorId name tier availableCentres').lean();
}

async function whoIsFreeWithBranches(date, time, options = {}) {
  const doctors = await team();
  const matches = await Promise.all(doctors.map(async (doctor) => {
    try {
      const result = await slotsForDate(doctor.doctorId, date, options);
      const wanted = parseClockMinutes(time);
      const slot = result.slots.find((item) => item.minutes === wanted && item.available);
      return (slot?.freeAt || []).map((branch) => ({ doctorId: doctor.doctorId, ...branch }));
    } catch (error) {
      // One broken employee link must remove that doctor, not every correctly
      // configured doctor. The direct doctor endpoint still returns the exact
      // configuration error when staff opens that row.
      require('../utils/logger').warn('Doctor omitted from Zenoti availability', { doctorId: doctor.doctorId, code: error.code, error: error.message });
      return [];
    }
  }));
  return matches.flat();
}

async function whoIsFree(date, time, options = {}) {
  return [...new Set((await whoIsFreeWithBranches(date, time, options)).map((row) => row.doctorId))];
}

async function anySlotsForDate(date, options = {}) {
  const doctors = await team();
  const settled = await Promise.allSettled(doctors.map((doctor) => slotsForDate(doctor.doctorId, date, options)));
  const byTime = new Map();
  const warnings = [];
  settled.forEach((entry, index) => {
    if (entry.status === 'rejected') {
      warnings.push({ doctorId: doctors[index].doctorId, code: entry.reason?.code || 'ZENOTI_CONFIGURATION_ERROR', message: entry.reason?.message });
      return;
    }
    entry.value.slots.forEach((slot) => {
    const row = byTime.get(slot.time) || { ...slot, freeWith: [], freeAt: [], available: false };
    if (slot.available) {
      row.available = true;
      row.booked = false;
      row.tooSoon = false;
      row.freeWith.push(doctors[index].doctorId);
      row.freeAt.push(...(slot.freeAt || []).map((branch) => ({ doctorId: doctors[index].doctorId, ...branch })));
    }
    byTime.set(slot.time, row);
    });
  });
  return { date, configured: true, source: 'zenoti-live', slotMinutes: SESSION_SLOT_MINUTES, slots: [...byTime.values()].sort((a, b) => a.minutes - b.minutes), warnings };
}

async function anyAvailabilityRange(from, to, options = {}) {
  const doctors = await team();
  const settled = await Promise.allSettled(doctors.map((doctor) => availabilityRange(doctor.doctorId, from, to, options)));
  const merged = new Map();
  const warnings = [];
  settled.forEach((entry, index) => {
    if (entry.status === 'rejected') {
      warnings.push({ doctorId: doctors[index].doctorId, code: entry.reason?.code || 'ZENOTI_CONFIGURATION_ERROR', message: entry.reason?.message });
      return;
    }
    entry.value.days.forEach((day) => {
    const current = merged.get(day.date) || { date: day.date, open: false, total: 0, free: 0 };
    current.open = current.open || day.open;
    current.total += day.total;
    current.free += day.free;
    merged.set(day.date, current);
    });
  });
  return { configured: true, source: 'zenoti-live', slotMinutes: SESSION_SLOT_MINUTES, days: [...merged.values()], warnings };
}

async function branchSlots(branchId, date, options = {}) {
  const branch = await branchById(branchId);
  const centerId = centerForBranch(branch);
  const [schedules, diary, practitioners] = await Promise.all([
    centerSchedule(centerId, date, date),
    centerDiary(centerId, date),
    ZenotiPractitioner.find({ active: true, centerIds: centerId, jobName: /^(doctor|therapist)$/i })
      .select('zenotiEmployeeId').lean(),
  ]);
  const providerIds = new Set(practitioners.map((row) => norm(row.zenotiEmployeeId)));
  const freeStarts = new Set();
  for (const employee of schedules || []) {
    const employeeId = norm(employee.employeeId);
    if (!providerIds.has(employeeId)) continue;
    const busy = [
      ...(diary.appointments || []).filter((row) => norm(row.therapistId) === employeeId && activeAppointment(row)).map(interval),
      ...(diary.blockouts || []).filter((row) => norm(row.therapistId) === employeeId).map(interval),
    ].filter(Boolean);
    for (const range of workingRanges(schedules, employee.employeeId, date)) {
      for (let at = parseClockMinutes(range.start); at + SESSION_SLOT_MINUTES <= parseClockMinutes(range.end); at += SESSION_SLOT_MINUTES) {
        if (!overlaps(busy, at, at + SESSION_SLOT_MINUTES)) freeStarts.add(at);
      }
    }
  }
  const starts = [...freeStarts].sort((a, b) => a - b);
  // A general treatment has no provider until staff confirms it. These are
  // centre working times from Zenoti; the final booking flow asks Zenoti for
  // service/provider-specific slots before it can become Confirmed.
  return {
    branchId: branch._id, branchName: branch.name, date,
    slots: starts.filter((minutes) => clinicDateTime(date, toHHMM(minutes)) >= (options.now || new Date())).map((minutes) => label(toHHMM(minutes))),
    slotDuration: SESSION_SLOT_MINUTES,
    source: 'zenoti-live',
    blockoutsSeen: (diary.blockouts || []).length,
  };
}

async function dayShifts(date, branchId) {
  const branch = await branchById(branchId);
  const centerId = centerForBranch(branch);
  const [schedules, diary, doctors] = await Promise.all([
    centerSchedule(centerId, date, date), centerDiary(centerId, date),
    Doctor.find({ isActive: true }).select('doctorId name tier designation photo displayOrder onlineBookingEnabled availableCentres').lean(),
  ]);
  const providers = [];
  for (const doctor of doctors.filter((row) => !row.availableCentres?.length || row.availableCentres.some((name) => norm(name) === norm(branch.name)))) {
    let practitioner;
    try {
      practitioner = await practitionerFor(doctor.doctorId, centerId);
    } catch (error) {
      providers.push({
        doctorId: doctor.doctorId, name: doctor.name, tier: doctor.tier,
        designation: doctor.designation, photo: doctor.photo || null,
        displayOrder: doctor.displayOrder || 0, onlineBookingEnabled: false,
        configured: false, onLeave: false, note: error.message, source: 'zenoti-configuration-error', ranges: [], blocks: [],
      });
      continue;
    }
    const ranges = workingRanges(schedules, practitioner.zenotiEmployeeId, date).map(({ start, end }) => ({ start, end }));
    const blocks = (diary.blockouts || []).filter((row) => norm(row.therapistId) === norm(practitioner.zenotiEmployeeId));
    providers.push({
      doctorId: doctor.doctorId, name: doctor.name, tier: doctor.tier,
      designation: doctor.designation, photo: doctor.photo || null,
      displayOrder: doctor.displayOrder || 0, onlineBookingEnabled: doctor.onlineBookingEnabled !== false,
      configured: true, onLeave: ranges.length === 0, note: ranges.length ? '' : 'Not working in Zenoti',
      source: 'zenoti-live', ranges,
      blocks: blocks.map((row) => ({ _id: row.id, startTime: row.startTime, endTime: row.endTime, title: row.title, notes: row.notes, source: 'zenoti' })),
    });
  }
  const minutes = providers.flatMap((provider) => provider.ranges.flatMap((range) => [parseClockMinutes(range.start), parseClockMinutes(range.end)])).filter((value) => value !== null);
  return {
    date,
    branch: { _id: branch._id, name: branch.name, open: minutes.length ? toHHMM(Math.min(...minutes)) : null, close: minutes.length ? toHHMM(Math.max(...minutes)) : null },
    providers: providers.sort((a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name)),
    otherBlocks: (diary.blockouts || []).filter((block) => !providers.some((provider) => provider.blocks.some((row) => row._id === block.id))),
    source: 'zenoti-live',
  };
}

async function providerBlocks({ from, to = from, branchId = null, doctorId = null } = {}) {
  const branches = branchId
    ? [await branchById(branchId)]
    : await Branch.find({ isActive: true, centreType: 'clinic' }).select('_id name zenotiCenterId').lean();
  const links = await ZenotiPractitioner.find({ active: true }).select('zenotiEmployeeId onboardedDoctorId').lean();
  const doctorByEmployee = new Map(links.map((row) => [norm(row.zenotiEmployeeId), row.onboardedDoctorId || null]));
  const output = [];
  for (const branch of branches) {
    const centerId = centerForBranch(branch);
    const diary = await centerDiaryRange(centerId, from, to);
    for (const row of diary.blockouts || []) {
      const linkedDoctorId = doctorByEmployee.get(norm(row.therapistId)) || null;
      if (doctorId && norm(linkedDoctorId) !== norm(doctorId)) continue;
      output.push({
        _id: row.id, source: 'zenoti', zenotiBlockoutId: row.blockoutId,
        zenotiEmployeeId: row.therapistId, doctorId: linkedDoctorId,
        providerName: row.therapistName, branchId: branch._id, branchName: branch.name,
        date: clinicDayStart(writtenDate(row.startTime)), startTime: clock(row.startTime), endTime: clock(row.endTime),
        startAt: clinicDateTime(writtenDate(row.startTime), clock(row.startTime)),
        endAt: clinicDateTime(writtenDate(row.endTime), clock(row.endTime)),
        title: row.title, notes: row.notes || '', color: row.color || null, active: true,
      });
    }
  }
  return output.sort((left, right) => new Date(left.startAt) - new Date(right.startAt));
}

module.exports = {
  _clearCache: () => cache.clear(),
  ZenotiAvailabilityError,
  anyAvailabilityRange,
  anySlotsForDate,
  availabilityRange,
  branchSlots,
  dayShifts,
  isSlotBookable,
  providerBlocks,
  slotsForDate,
  whoIsFree,
  whoIsFreeWithBranches,
};
