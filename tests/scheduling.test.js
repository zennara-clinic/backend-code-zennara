const test = require('node:test');
const assert = require('node:assert/strict');

const Booking = require('../models/Booking');
const Branch = require('../models/Branch');
const Doctor = require('../models/Doctor');
const DermatologistSchedule = require('../models/DermatologistSchedule');
const ZenotiPractitioner = require('../models/ZenotiPractitioner');
const zenoti = require('../services/zenotiService');
const liveAvailability = require('../services/zenotiAvailabilityService');
const {
  getBranchSlotsForDate,
  validateBranchBooking,
  validateBranchSession,
} = require('../utils/branchSchedule');
const { slotsForDate, whoIsFreeWithBranches } = require('../utils/dermatologistSlots');
const {
  bookingScheduledAt, clinicDateKey, clinicDateTime, clinicDayEnd, clinicDayStart,
} = require('../utils/bookingTime');
const { buildBookingQuery } = require('../utils/listFilters');

const allDays = Object.fromEntries(
  ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
    .map((day) => [day, { isOpen: true, openTime: '11:00', closeTime: '14:00' }]),
);

test('treatment slots are hourly even when an old branch record says 30 minutes', () => {
  const branch = { slotDuration: 30, operatingHours: allDays };
  assert.deepEqual(getBranchSlotsForDate(branch, '2030-01-01'), [
    '11:00 AM',
    '12:00 PM',
    '1:00 PM',
  ]);

  assert.equal(
    validateBranchBooking(branch, '2030-01-01', ['10:30 AM'], new Date('2029-12-01')).ok,
    false,
  );
  assert.equal(
    validateBranchBooking(branch, '2030-01-01', ['11:00 AM'], new Date('2029-12-01')).ok,
    true,
  );
  // An off-grid start that still fits inside 11:00–14:00 is a valid session
  // (11:30–12:30); one that runs past close (13:30–14:30) is not.
  assert.equal(
    validateBranchSession(branch, '2030-01-01', ['11:30 AM'], new Date('2029-12-01')).ok,
    true,
  );
  assert.equal(
    validateBranchSession(branch, '2030-01-01', ['1:30 PM'], new Date('2029-12-01')).ok,
    false,
  );
});

test('doctor slots are hourly and overlapping legacy bookings block the full hour', async () => {
  const originalBookingFind = Booking.find;
  const originalDoctorFindOne = Doctor.findOne;
  const originalBranchFind = Branch.find;
  const originalPractitionerFind = ZenotiPractitioner.find;
  const originalSchedules = zenoti.getCenterEmployeeSchedules;
  const originalDiary = zenoti.getCenterDiary;
  let bookings = [];

  Doctor.findOne = () => ({ select() { return this; }, lean: async () => ({ doctorId: 'doctor-test', isActive: true, availableCentres: ['Jubilee Hills'] }) });
  Branch.find = () => ({ select() { return this; }, sort() { return this; }, lean: async () => [{ _id: 'branch-jubilee', name: 'Jubilee Hills' }] });
  ZenotiPractitioner.find = () => ({ select() { return this; }, limit() { return this; }, lean: async () => [{ zenotiEmployeeId: 'employee-test' }] });
  zenoti.getCenterEmployeeSchedules = async () => [{ employeeId: 'employee-test', shifts: [{ date: '2030-01-01', start: '2030-01-01T11:00:00', end: '2030-01-01T14:00:00', status: 0 }] }];
  zenoti.getCenterDiary = async () => ({ appointments: [], blockouts: [] });
  Booking.find = () => ({
    select() { return this; },
    lean: async () => bookings,
  });

  try {
    liveAvailability._clearCache();
    const free = await slotsForDate('doctor-test', '2030-01-01', {
      now: new Date(2029, 11, 15, 9, 0),
    });
    assert.equal(free.slotMinutes, 60);
    assert.deepEqual(free.slots.map((slot) => slot.time), ['11:00', '12:00', '13:00']);
    assert.ok(free.slots.every((slot) => slot.available));

    // A pre-change 11:30 booking now occupies 11:30–12:30, so neither the
    // 11:00 nor 12:00 one-hour session may be sold around it.
    bookings = [{ slotTime: '11:30', preferredTimeSlots: [] }];
    const occupied = await slotsForDate('doctor-test', '2030-01-01', {
      now: new Date(2029, 11, 15, 9, 0),
    });
    assert.deepEqual(
      occupied.slots.map((slot) => ({ time: slot.time, booked: slot.booked })),
      [
        { time: '11:00', booked: true },
        { time: '12:00', booked: true },
        { time: '13:00', booked: false },
      ],
    );
  } finally {
    Booking.find = originalBookingFind;
    Doctor.findOne = originalDoctorFindOne;
    Branch.find = originalBranchFind;
    ZenotiPractitioner.find = originalPractitionerFind;
    zenoti.getCenterEmployeeSchedules = originalSchedules;
    zenoti.getCenterDiary = originalDiary;
    liveAvailability._clearCache();
  }
});

test('new dermatologist schedules default to one hour', () => {
  assert.equal(DermatologistSchedule.blank('doctor-test').slotMinutes, 60);
});

test('doctor and treatment booking changes close 24 hours before check-in', () => {
  const clinicMidnight = clinicDateTime('2030-01-01', '00:00');
  const appointmentDate = clinicDateTime('2030-01-02', '00:00');
  const outsideWindow = clinicMidnight;
  const insideWindow = new Date(clinicMidnight.getTime() + 2 * 60 * 60 * 1000);

  const doctorBooking = new Booking({
    status: 'Confirmed',
    preferredDate: appointmentDate,
    slotTime: '01:00',
  });
  assert.equal(doctorBooking.canBeCancelled(outsideWindow), true);
  assert.equal(doctorBooking.canBeRescheduled(outsideWindow), true);
  assert.equal(doctorBooking.canBeCancelled(insideWindow), false);
  assert.equal(doctorBooking.canBeRescheduled(insideWindow), false);

  const treatmentBooking = new Booking({
    status: 'Awaiting Confirmation',
    preferredDate: appointmentDate,
    preferredTimeSlots: ['01:00', '02:00'],
  });
  assert.equal(treatmentBooking.canBeCancelled(outsideWindow), true);
  assert.equal(treatmentBooking.canBeCancelled(insideWindow), false);
});

test('any available returns free dermatologists across clinics with their actual clinic', async () => {
  const originalDoctorFind = Doctor.find;
  const originalDoctorFindOne = Doctor.findOne;
  const originalBranchFind = Branch.find;
  const originalPractitionerFind = ZenotiPractitioner.find;
  const originalSchedules = zenoti.getCenterEmployeeSchedules;
  const originalDiary = zenoti.getCenterDiary;
  const originalBookingFind = Booking.find;

  const branches = [
    { _id: 'branch-jubilee', name: 'Jubilee Hills' },
    { _id: 'branch-kondapur', name: 'Kondapur' },
  ];
  const doctors = [
    {
      doctorId: 'doctor-jubilee',
      availableCentres: ['Jubilee Hills'],
    },
    {
      doctorId: 'doctor-kondapur',
      availableCentres: ['Kondapur'],
    },
  ];

  Doctor.find = () => ({
    select() { return this; },
    lean: async () => doctors,
  });
  Doctor.findOne = ({ doctorId }) => ({ select() { return this; }, lean: async () => doctors.find((doctor) => doctor.doctorId === doctorId) });
  Branch.find = (query) => ({
    select() { return this; },
    sort() { return this; },
    lean: async () => query?._id
      ? branches.filter((branch) => String(branch._id) === String(query._id))
      : query?.name instanceof RegExp ? branches.filter((branch) => query.name.test(branch.name)) : branches,
  });
  ZenotiPractitioner.find = (query) => ({ select() { return this; }, limit() { return this; }, lean: async () => [{ zenotiEmployeeId: query.onboardedDoctorId === 'doctor-jubilee' ? 'employee-jubilee' : 'employee-kondapur' }] });
  zenoti.getCenterEmployeeSchedules = async (centerId) => [{
    employeeId: centerId.startsWith('c9f') ? 'employee-jubilee' : 'employee-kondapur',
    shifts: [{ date: '2030-01-01', start: '2030-01-01T11:00:00', end: '2030-01-01T14:00:00', status: 0 }],
  }];
  zenoti.getCenterDiary = async () => ({ appointments: [], blockouts: [] });
  Booking.find = () => ({
    select() { return this; },
    lean: async () => [],
  });

  try {
    liveAvailability._clearCache();
    const network = await whoIsFreeWithBranches('2030-01-01', '11:00', {
      now: new Date('2029-12-15T00:00:00.000Z'),
    });
    assert.deepEqual(network, [
      {
        doctorId: 'doctor-jubilee',
        branchId: 'branch-jubilee',
        branchName: 'Jubilee Hills',
      },
      {
        doctorId: 'doctor-kondapur',
        branchId: 'branch-kondapur',
        branchName: 'Kondapur',
      },
    ]);

    const kondapurOnly = await whoIsFreeWithBranches('2030-01-01', '11:00', {
      branchName: 'kondapur',
      now: new Date('2029-12-15T00:00:00.000Z'),
    });
    assert.deepEqual(kondapurOnly.map((match) => match.doctorId), ['doctor-kondapur']);
  } finally {
    Doctor.find = originalDoctorFind;
    Doctor.findOne = originalDoctorFindOne;
    Branch.find = originalBranchFind;
    ZenotiPractitioner.find = originalPractitionerFind;
    zenoti.getCenterEmployeeSchedules = originalSchedules;
    zenoti.getCenterDiary = originalDiary;
    Booking.find = originalBookingFind;
    liveAvailability._clearCache();
  }
});

test('clinic dates and appointment instants never inherit the EC2 or browser timezone', async () => {
  const start = clinicDayStart('2026-09-01');
  const end = clinicDayEnd('2026-09-01');
  assert.equal(start.toISOString(), '2026-08-31T18:30:00.000Z');
  assert.equal(end.toISOString(), '2026-09-01T18:29:59.999Z');
  assert.equal(clinicDateKey(start), '2026-09-01');

  const scheduled = bookingScheduledAt({
    preferredDate: start,
    preferredTimeSlots: ['10:00 AM'],
  });
  assert.equal(scheduled.toISOString(), '2026-09-01T04:30:00.000Z');

  const { query } = await buildBookingQuery({ date: '2026-09-01' });
  const range = query.$and[0].$or[0].confirmedDate;
  assert.equal(range.$gte.toISOString(), start.toISOString());
  assert.equal(range.$lte.toISOString(), end.toISOString());
});

test('the clinic-wide booking window caps every slot source', () => {
  // 2030-01-01 is a Tuesday, 2030-01-06 a Sunday.
  const { clampToBookingWindow } = require('../utils/dermatologistSlots');
  const wide = [{ start: '08:00', end: '21:00' }];
  assert.deepEqual(clampToBookingWindow(wide, '2030-01-01'), [{ start: '11:00', end: '18:00' }]);
  assert.deepEqual(clampToBookingWindow(wide, '2030-01-06'), [{ start: '11:00', end: '15:00' }]);
  // A dermatologist sitting only part of the window keeps their own hours.
  assert.deepEqual(clampToBookingWindow([{ start: '12:00', end: '14:00' }], '2030-01-01'), [{ start: '12:00', end: '14:00' }]);
  // Entirely outside the window → nothing to sell.
  assert.deepEqual(clampToBookingWindow([{ start: '18:00', end: '20:00' }], '2030-01-01'), []);

  // Treatment slots come from the centre's own hours and must be capped too:
  // a centre open 09:00–20:00 still only sells 11:00–17:00 starts.
  const open = Object.fromEntries(
    ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
      .map((day) => [day, { isOpen: true, openTime: '09:00', closeTime: '20:00' }]),
  );
  assert.deepEqual(getBranchSlotsForDate({ slotDuration: 60, operatingHours: open }, '2030-01-01'), [
    '11:00 AM', '12:00 PM', '1:00 PM', '2:00 PM', '3:00 PM', '4:00 PM', '5:00 PM',
  ]);
  assert.deepEqual(getBranchSlotsForDate({ slotDuration: 60, operatingHours: open }, '2030-01-06'), [
    '11:00 AM', '12:00 PM', '1:00 PM', '2:00 PM',
  ]);
});

/*
 * Availability must never hard-fail on a configuration gap.
 *
 * On 2026-09-08 Janaki was listed at three centres in the panel and existed in
 * Zenoti at one, so the per-doctor slots endpoint answered 409
 * ZENOTI_PRACTITIONER_UNMAPPED and the app's slot screen broke for her. The
 * clinic-wide endpoint already degraded to a warning; this one did not.
 */
test('a doctor unmapped at one centre yields no slots there, never an error', () => {
  const src = require('fs').readFileSync(require.resolve('../services/zenotiAvailabilityService.js'), 'utf8');
  const i = src.indexOf('const CONFIG_CODES');
  assert.ok(i > -1, 'configuration errors must be separated from real outages');
  const block = src.slice(i, i + 900);
  assert.match(block, /ZENOTI_PRACTITIONER_UNMAPPED/);
  assert.match(block, /AMBIGUOUS_ZENOTI_PRACTITIONER/);
  assert.match(block, /if \(!CONFIG_CODES\.has\(error\?\.code\)\) throw error/,
    'a genuine Zenoti outage must still fail loudly');
});

/*
 * Zenoti is the schedule of record, so it decides WHERE a doctor can be booked
 * too. Seven of nine active dermatologists had Doctor.availableCentres out of
 * step with their Zenoti links on 2026-09-08.
 */
test('bookable centres come from the Zenoti link, not the hand-typed list', () => {
  const src = require('fs').readFileSync(require.resolve('../services/zenotiAvailabilityService.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function candidateBranches'), src.indexOf('async function practitionerFor'));
  const linked = fn.indexOf('linkedCentres');
  const fallback = fn.indexOf('availableCentres');
  assert.ok(linked > -1, 'the Zenoti link must drive centre choice');
  assert.ok(fallback > linked, 'availableCentres may only be the fallback for an unlinked doctor');
});

/*
 * Slot reads are what a guest is staring at, so they must not queue behind the
 * background crawl. On 2026-09-08 a month calendar took 40s on production for
 * exactly that reason.
 */
test('a guest waiting on a screen outranks a background crawl', () => {
  const src = require('fs').readFileSync(require.resolve('../services/zenotiService.js'), 'utf8');
  assert.match(src, /const FOREGROUND = 1/);
  assert.match(src, /priorityStore\.getStore\(\) \?\? FOREGROUND/,
    'anything that does not opt out must be treated as user-facing');
  assert.match(src, /STARVATION_MS/, 'a starved background caller must still be promoted');

  const sched = require('fs').readFileSync(require.resolve('../utils/zenotiScheduler.js'), 'utf8');
  assert.match(sched, /const bg = \(fn\) => \(\) =>/, 'bg must RETURN the handler, not run it');
  // Every cron job must be wrapped, or it silently keeps foreground priority.
  const jobs = (sched.match(/cron\.schedule\(/g) || []).length;
  const wrapped = (sched.match(/cron\.schedule\([^,]+, bg\(/g) || []).length;
  assert.equal(wrapped, jobs, `all ${jobs} scheduled jobs must run at background priority`);
});

test('a month calendar is fetched as parallel pages, not one week at a time', () => {
  const src = require('fs').readFileSync(require.resolve('../services/zenotiAvailabilityService.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function centerDiaryRange'), src.indexOf('async function centerDiaryRange') + 1200);
  assert.match(fn, /Promise\.all\(windows\.map/, 'the seven-day pages are independent reads');
  assert.doesNotMatch(fn, /await zenoti\.getCenterDiary\([\s\S]{0,80}\n\s*appointments\.push/,
    'they must not be awaited one after another again');
});

/*
 * Zenoti decides where a practitioner works, so it decides which centres the
 * app offers them at. Doctor.availableCentres was typed by hand and had
 * drifted for seven of nine active dermatologists on 2026-09-08.
 */
test('a linked doctor\'s centres are rewritten from Zenoti, never typed', () => {
  const src = require('fs').readFileSync(require.resolve('../services/zenotiPractitionerService.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function stampDoctorLink'), src.indexOf('async function autoOnboardTherapist'));
  assert.match(fn, /availableCentres/, 'the sync must own availableCentres');
  assert.match(fn, /zenotiNames\.includes/, 'Zenoti names must be MATCHED to our branches, not copied blindly');
  assert.match(fn, /if \(zenotiNames\.length\)/,
    'a doctor with no Zenoti centres must keep whatever the panel set');
});

/*
 * "Where does this dermatologist work" must have ONE answer.
 *
 * There were three: Doctor.availableCentres, the ZenotiPractitioner link, and
 * a hand-maintained DermatologistAvailability collection. The APP filters its
 * dermatologist list on the third, so on 2026-09-08 fixing the first two
 * changed nothing on screen — Janaki was still offered at Financial District
 * and Kondapur, and Rickson was still hidden at Financial District.
 */
test('the availability endpoint derives from the Zenoti-synced doctor record', () => {
  const src = require('fs').readFileSync(require.resolve('../controllers/dermatologistAvailabilityController.js'), 'utf8');
  assert.match(src, /async function derivedFromDoctors/, 'branches must come from the Doctor record');
  const getAll = src.slice(src.indexOf('exports.getAll'), src.indexOf('exports.getOne'));
  assert.match(getAll, /derivedFromDoctors\(\)/, 'getAll must derive, not read the legacy collection first');
  const getOne = src.slice(src.indexOf('exports.getOne'), src.indexOf('exports.upsert'));
  assert.match(getOne, /derivedFromDoctors\(\)/, 'getOne must derive too');
  // Branch names are matched, never trusted verbatim.
  assert.match(src, /trim\(\)\.toLowerCase\(\)/, 'centre names must be matched to real branches');
});

/*
 * Priority decides who goes NEXT; it does not create capacity. Background jobs
 * were spending ~45 of the 50 calls a minute, so a guest's request reached the
 * front of the queue and then waited for the window to roll — 28s measured for
 * one "any dermatologist" read beside 1.1s single-doctor reads.
 */
test('background work never spends the last slice of the rate window', () => {
  const src = require('fs').readFileSync(require.resolve('../services/zenotiService.js'), 'utf8');
  assert.match(src, /BACKGROUND_CEILING = Math\.max\(1, Math\.floor\(RATE_LIMIT_PER_MINUTE \* 0\.7\)\)/,
    'a reserve must be held back from background callers');
  assert.match(src, /const limit = wantsForeground \? RATE_LIMIT_PER_MINUTE : BACKGROUND_CEILING/,
    'only a foreground request may spend the reserve');
  // Background must re-check quickly, not sleep out the whole window, or a
  // guest arriving a moment later waits for nothing.
  assert.match(src, /callTimestamps\.length >= RATE_LIMIT_PER_MINUTE\s*\n?\s*\? 60_000/,
    'only the hard cap waits for the window to roll');
});

/*
 * The clinic-wide fan-out asks the same questions once per dermatologist.
 * Nine identical branch reads and nine team reads per screen is nine Atlas
 * round trips that buy nothing.
 */
test('the any-dermatologist fan-out does not re-read what it already has', () => {
  const src = require('fs').readFileSync(require.resolve('../services/zenotiAvailabilityService.js'), 'utf8');
  assert.match(src, /cached\(`branch:\$\{branchId\}`/, 'the same branch must be read once');
  assert.match(src, /cached\(`prac:/, 'the same practitioner lookup must be read once');
  assert.match(src, /options\.doctor\s*\n?\s*\|\|/, 'a doctor row already loaded must be reused');
  assert.match(src, /\{ \.\.\.options, doctor \}/, 'the fan-out must pass the row it loaded');
});
