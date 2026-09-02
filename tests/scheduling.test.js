const test = require('node:test');
const assert = require('node:assert/strict');

const Booking = require('../models/Booking');
const Branch = require('../models/Branch');
const Doctor = require('../models/Doctor');
const DermatologistSchedule = require('../models/DermatologistSchedule');
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
    .map((day) => [day, { isOpen: true, openTime: '10:00', closeTime: '13:00' }]),
);

test('treatment slots are hourly even when an old branch record says 30 minutes', () => {
  const branch = { slotDuration: 30, operatingHours: allDays };
  assert.deepEqual(getBranchSlotsForDate(branch, '2030-01-01'), [
    '10:00 AM',
    '11:00 AM',
    '12:00 PM',
  ]);

  assert.equal(
    validateBranchBooking(branch, '2030-01-01', ['10:30 AM'], new Date('2029-12-01')).ok,
    false,
  );
  assert.equal(
    validateBranchBooking(branch, '2030-01-01', ['11:00 AM'], new Date('2029-12-01')).ok,
    true,
  );
  assert.equal(
    validateBranchSession(branch, '2030-01-01', ['10:30 AM'], new Date('2029-12-01')).ok,
    true,
  );
  assert.equal(
    validateBranchSession(branch, '2030-01-01', ['12:30 PM'], new Date('2029-12-01')).ok,
    false,
  );
});

test('doctor slots are hourly and overlapping legacy bookings block the full hour', async () => {
  const originalScheduleFind = DermatologistSchedule.findOne;
  const originalBookingFind = Booking.find;
  const originalDoctorFindOne = Doctor.findOne;
  let bookings = [];

  DermatologistSchedule.findOne = () => ({
    lean: async () => ({
      doctorId: 'doctor-test',
      isActive: true,
      // Proves existing persisted settings cannot restore half-hour slots.
      slotMinutes: 30,
      leadTimeHours: 0,
      horizonDays: 60,
      weekly: [{
        day: new Date(2030, 0, 1).getDay(),
        branchId: null,
        ranges: [{ start: '10:00', end: '13:00' }],
      }],
      overrides: [],
    }),
  });
  Booking.find = () => ({
    select() { return this; },
    lean: async () => bookings,
  });
  Doctor.findOne = () => ({ select() { return this; }, lean: async () => ({ isActive: true }) });

  try {
    const free = await slotsForDate('doctor-test', '2030-01-01', {
      now: new Date(2029, 11, 15, 9, 0),
    });
    assert.equal(free.slotMinutes, 60);
    assert.deepEqual(free.slots.map((slot) => slot.time), ['10:00', '11:00', '12:00']);
    assert.ok(free.slots.every((slot) => slot.available));

    // A pre-change 10:30 booking now occupies 10:30–11:30, so neither the
    // 10:00 nor 11:00 one-hour session may be sold around it.
    bookings = [{ slotTime: '10:30', preferredTimeSlots: [] }];
    const occupied = await slotsForDate('doctor-test', '2030-01-01', {
      now: new Date(2029, 11, 15, 9, 0),
    });
    assert.deepEqual(
      occupied.slots.map((slot) => ({ time: slot.time, booked: slot.booked })),
      [
        { time: '10:00', booked: true },
        { time: '11:00', booked: true },
        { time: '12:00', booked: false },
      ],
    );
  } finally {
    DermatologistSchedule.findOne = originalScheduleFind;
    Booking.find = originalBookingFind;
    Doctor.findOne = originalDoctorFindOne;
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
  const originalBranchFindById = Branch.findById;
  const originalScheduleFind = DermatologistSchedule.findOne;
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
  Doctor.findOne = () => ({ select() { return this; }, lean: async () => ({ isActive: true }) });
  Branch.find = (query) => ({
    select() { return this; },
    lean: async () => query?._id
      ? branches.filter((branch) => String(branch._id) === String(query._id))
      : branches,
  });
  Branch.findById = async (id) => ({
    _id: id,
    closureFor: () => null,
    hoursFor: () => ({ open: '10:00', close: '13:00' }),
  });
  DermatologistSchedule.findOne = ({ doctorId }) => ({
    lean: async () => ({
      doctorId,
      isActive: true,
      leadTimeHours: 0,
      horizonDays: 60,
      weekly: [{
        day: new Date(Date.UTC(2030, 0, 1)).getUTCDay(),
        branchId: doctorId === 'doctor-jubilee' ? 'branch-jubilee' : 'branch-kondapur',
        ranges: [{ start: '10:00', end: '13:00' }],
      }],
      overrides: [],
    }),
  });
  Booking.find = () => ({
    select() { return this; },
    lean: async () => [],
  });

  try {
    const network = await whoIsFreeWithBranches('2030-01-01', '10:00', {
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

    const kondapurOnly = await whoIsFreeWithBranches('2030-01-01', '10:00', {
      branchName: 'kondapur',
      now: new Date('2029-12-15T00:00:00.000Z'),
    });
    assert.deepEqual(kondapurOnly.map((match) => match.doctorId), ['doctor-kondapur']);
  } finally {
    Doctor.find = originalDoctorFind;
    Doctor.findOne = originalDoctorFindOne;
    Branch.find = originalBranchFind;
    Branch.findById = originalBranchFindById;
    DermatologistSchedule.findOne = originalScheduleFind;
    Booking.find = originalBookingFind;
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
