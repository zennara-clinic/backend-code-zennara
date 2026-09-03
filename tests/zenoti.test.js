const test = require('node:test');
const assert = require('node:assert/strict');

const zenoti = require('../services/zenotiService');
const { isMembershipCurrentlyActive } = require('../services/zenotiSyncService');
const User = require('../models/User');
const Booking = require('../models/Booking');
const { appointmentLocalParts, localStatus } = require('../services/zenotiAppointmentSyncService');
const { buildDoctorMatcher } = require('../utils/dermatologistMatch');

test('full guest profile keeps root-level address and operational fields', () => {
  const guest = zenoti.normalizeGuest({
    id: 'guest-1',
    center_id: 'center-1',
    code: 'G-1',
    is_online_booking_blocked: true,
    personal_info: {
      first_name: 'A', last_name: 'Patient', gender_name: 'Female',
      mobile_phone: { number: '+91 98765 43210' }, preferred_name: 'Asha',
    },
    address_info: { address1: 'Road 1', city: 'Hyderabad', zip_code: '500001' },
  });

  assert.equal(guest.phone, '9876543210');
  assert.equal(guest.preferredName, 'Asha');
  assert.equal(guest.address.line1, 'Road 1');
  assert.equal(guest.address.city, 'Hyderabad');
  assert.equal(guest.isOnlineBookingBlocked, true);
});

test('package normalizer retains service and product balances', () => {
  const pkg = zenoti.normalizePackage({
    user_package_id: 'pkg-1', status: 1, purchase_price: 12000,
    package: { name: 'Skin Plan' }, date: { purchase_date: '2026-01-01', end: '2027-01-01' },
    services: [{ service_type_info: { name: 'Peel' }, total: 6, used: 2, balance: 4 }],
    products: [{ product_info: { name: 'Cleanser' }, total: 2, used: 1, balance: 1 }],
    redemption_setting_details: { total_payment: 11500, is_frozen: false },
  });

  assert.equal(pkg.name, 'Skin Plan');
  assert.equal(pkg.sessionsTotal, 6);
  assert.equal(pkg.sessionsRemaining, 4);
  assert.equal(pkg.products[0].name, 'Cleanser');
  assert.equal(pkg.totalPayment, 11500);
});

test('membership normalizer retains Zen benefits and active status is correct', () => {
  const membership = zenoti.normalizeMembership({
    user_membership_id: 'mem-1', status: 1, member_since: '2026-01-01', expiry_date: '2099-01-01',
    membership: { name: 'Zen Membership', code: 'ZEN' },
    services: [{ service: { name: 'Hydrafacial' }, total: 4, used: 1, balance: 3 }],
    products: [{ product: { name: 'Serum' }, total: 1, used: 0, balance: 1 }],
    guestpass_total: 2, guestpass_balance: 1,
  });

  assert.equal(membership.products[0].name, 'Serum');
  assert.equal(membership.guestPassBalance, 1);
  assert.equal(isMembershipCurrentlyActive(membership), true);
  assert.equal(isMembershipCurrentlyActive({ status: 5, expiryDate: '2099-01-01' }), false);
});

test('note and form normalizers return stable admin-panel shapes', () => {
  const note = zenoti.normalizeGuestNote({ note_id: 'n1', notes: 'Patch test', is_profile_alert: true, created_by: { name: 'Staff', date: '2026-01-01' } });
  const form = zenoti.normalizeGuestForm({ form_id: 'f1', name: 'Consent', form_filled_status: 2, last_filled_date: '2026-01-02' });
  assert.deepEqual({ text: note.text, alert: note.isProfileAlert, by: note.createdBy }, { text: 'Patch test', alert: true, by: 'Staff' });
  assert.deepEqual({ name: form.name, status: form.status, at: form.lastFilledAt }, { name: 'Consent', status: 2, at: '2026-01-02' });
});

test('clinic-only Zenoti patients may be indexed without a phone, app sign-ups may not', () => {
  const clinic = new User({ email: 'clinic-only@guest.zennara.in', fullName: 'Clinic Only', location: 'Jubilee Hills', source: 'zenoti' });
  const app = new User({ email: 'app@example.com', fullName: 'App User', location: 'Jubilee Hills', source: 'app' });
  assert.equal(clinic.validateSync()?.errors?.phone, undefined);
  assert.ok(app.validateSync()?.errors?.phone);
});

test('center appointment normalizer retains operational schedule identifiers', () => {
  const appointment = zenoti.normalizeCenterAppointment({
    appointment_id: 'appt-1', appointment_group_id: 'group-1', invoice_id: 'invoice-1', invoice_item_id: 'item-1',
    service: { id: 'service-1', name: 'Hydrafacial', category: { name: 'Skin' } },
    guest: { id: 'guest-1', first_name: 'A', last_name: 'Patient', mobile: { display_number: '+91 98765 43210' } },
    start_time: '2026-08-23T10:00:00', end_time: '2026-08-23T11:00:00', status: 4,
    therapist: { id: 'employee-1', display_name: 'Doctor' }, room: { name: 'Room 2' },
    is_prescription_signed: true,
  }, 'center-1');

  assert.equal(appointment.id, 'appt-1');
  assert.equal(appointment.invoiceItemId, 'item-1');
  assert.equal(appointment.serviceId, 'service-1');
  assert.equal(appointment.guest.phone, '9876543210');
  assert.equal(appointment.roomName, 'Room 2');
  assert.equal(appointment.isPrescriptionSigned, true);
});

test('Zenoti lifecycle maps to real Booking statuses', () => {
  assert.equal(localStatus({ status: 4, progress: 0 }), 'Confirmed');
  assert.equal(localStatus({ status: 2, progress: 0 }), 'In Progress');
  assert.equal(localStatus({ status: 0, progress: 2 }), 'Completed');
  assert.equal(localStatus({ status: -1 }), 'Cancelled');
  assert.equal(localStatus({ status: -2 }), 'No Show');
});

test('Zenoti appointment time keeps the clinic day for wall-clock and UTC payloads', () => {
  const local = appointmentLocalParts('2026-09-01T10:00:00');
  assert.equal(local.day, '2026-09-01');
  assert.equal(local.time, '10:00');
  assert.equal(local.date.toISOString(), '2026-08-31T18:30:00.000Z');

  const utc = appointmentLocalParts('2026-09-01T18:30:00Z');
  assert.equal(utc.day, '2026-09-02');
  assert.equal(utc.time, '00:00');
});

test('Zenoti bookings may retain an external service before catalogue mapping', () => {
  const booking = new Booking({
    source: 'zenoti', userId: '64b64c0f6d93b76360a1c111', fullName: 'Clinic Patient',
    preferredLocation: 'Jubilee Hills', preferredDate: new Date(), preferredTimeSlots: ['10:00'], amount: 0,
  });
  const error = booking.validateSync();
  assert.equal(error?.errors?.consultationId, undefined);
  assert.equal(error?.errors?.mobileNumber, undefined);
  assert.equal(error?.errors?.email, undefined);
});

test('doctor matching accepts Zenoti surname differences only for a unique onboarded first name', () => {
  const match = buildDoctorMatcher([
    { doctorId: 'spoorthy-nagineni', name: 'Dr Spoorthy Nagineni' },
    { doctorId: 'shilpa-reddy-gill', name: 'Dr Shilpa Reddy Gill' },
  ]);
  assert.equal(match('Dr Spoorthy Rao')?.doctorId, 'spoorthy-nagineni');
  assert.equal(match('Dr Shilpa Gill')?.doctorId, 'shilpa-reddy-gill');
});

test('doctor matching never assigns unrelated Zenoti treatment staff', () => {
  const match = buildDoctorMatcher([
    { doctorId: 'spoorthy-nagineni', name: 'Dr Spoorthy Nagineni' },
    { doctorId: 'shilpa-reddy-gill', name: 'Dr Shilpa Reddy Gill' },
  ]);
  assert.equal(match('Vennela K'), null);
  assert.equal(match('Praveen K'), null);
  assert.equal(match('Dr Varsha Reddy'), null);
});

/* ------------------------------------------------------------------------ *
 * Guards added after the 2026-09-03 no-show incident.
 * ------------------------------------------------------------------------ */
const { mergeStatus, appointmentAttended } = require('../services/zenotiAppointmentSyncService');
const zenotiWrite = require('../services/zenotiWriteService');

test('inbound merge keeps a desk-advanced state while Zenoti is unchanged, and lets Zenoti terminal states win', () => {
  const local = (status, zs, zp = 0) => ({ status, zenotiSource: { status: zs, progress: zp } });
  const feed = (status, progress = 0) => ({ status, progress });
  assert.equal(mergeStatus(local('In Progress', 0), feed(0), 'Confirmed', false), 'In Progress');
  assert.equal(mergeStatus(local('Completed', 0), feed(0), 'Confirmed', false), 'Completed');
  assert.equal(mergeStatus(local('No Show', 0), feed(0), 'Confirmed', false), 'No Show');
  assert.equal(mergeStatus(local('No Show', 0), feed(2, 1), 'In Progress', false), 'In Progress');
  assert.equal(mergeStatus(local('In Progress', 2), feed(1), 'Completed', false), 'Completed');
  assert.equal(mergeStatus(local('Completed', 0), feed(-1), 'Cancelled', false), 'Cancelled');
  assert.equal(mergeStatus(local('Cancelled', 'vanished'), feed(0), 'Confirmed', false), 'Confirmed');
  assert.equal(mergeStatus({}, feed(0), 'Confirmed', true), 'Confirmed');
});

test('a Zenoti appointment counts as attended on check-in, start or close', () => {
  assert.equal(appointmentAttended({ status: 0, progress: 0 }), false);
  assert.equal(appointmentAttended({ status: 0, progress: 0, checkinTime: '2026-09-03T10:00:00' }), true);
  assert.equal(appointmentAttended({ status: 2, progress: 0 }), true);
  assert.equal(appointmentAttended({ status: 0, progress: 1 }), true);
  assert.equal(appointmentAttended({ status: 1, progress: 2 }), true);
  assert.equal(appointmentAttended({ status: -2, progress: 0 }), false);
});

test('desk write-back is on by default and can be paused; editing existing Zenoti records stays off unless enabled', () => {
  const prev = { l: process.env.ZENOTI_LIFECYCLE_WRITEBACK, e: process.env.ZENOTI_EDIT_EXISTING_WRITEBACK };
  delete process.env.ZENOTI_LIFECYCLE_WRITEBACK; delete process.env.ZENOTI_EDIT_EXISTING_WRITEBACK;
  assert.equal(zenotiWrite.lifecycleWritebackEnabled(), true);
  assert.equal(zenotiWrite.existingRecordWritebackEnabled(), false);
  process.env.ZENOTI_LIFECYCLE_WRITEBACK = 'false';
  assert.equal(zenotiWrite.lifecycleWritebackEnabled(), false);
  if (prev.l === undefined) delete process.env.ZENOTI_LIFECYCLE_WRITEBACK; else process.env.ZENOTI_LIFECYCLE_WRITEBACK = prev.l;
  if (prev.e === undefined) delete process.env.ZENOTI_EDIT_EXISTING_WRITEBACK; else process.env.ZENOTI_EDIT_EXISTING_WRITEBACK = prev.e;
});

test('the write breaker reports its limits and starts untripped', () => {
  const status = zenotiWrite.breakerStatus();
  assert.equal(status.tripped, false);
  assert.ok(status.limit15Min >= 1 && status.limitHour >= status.limit15Min);
  assert.equal(status.writesLast15Min, 0);
});

test('the automatic no-show job never considers Zenoti-linked bookings', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../services/bookingStatusService.js'), 'utf8');
  assert.ok(src.includes("source: { $nin: ['zenoti'] }"), 'query must exclude source zenoti');
  assert.ok(src.includes('zenotiAppointmentId: null'), 'query must exclude Zenoti-linked rows');
  assert.ok(src.includes('booking.$locals.skipZenotiWrite = true'), 'auto no-show must never write to Zenoti');
});

test('Branch virtuals tolerate the partial projection used when populating bookings', () => {
  const Branch = require('../models/Branch');
  const partial = new Branch({ name: 'Jubilee Hills' });
  assert.doesNotThrow(() => partial.toObject({ virtuals: true }));
  assert.equal(partial.formattedPhone, '');
});

test('service resolution ignores tier words but package resolution never guesses', () => {
  const { looseKey } = zenotiWrite;
  assert.equal(looseKey('Senior Dermatologist Consultation'), 'consultation');
  assert.equal(looseKey('Dr. Rickson Consultations'), 'rickson consultations');
  assert.notEqual(looseKey('Glow Before the Vow'), looseKey('3 Facials'));
});

test('a Zenoti-booked appointment can never be cancelled, rescheduled or no-showed from our side', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../controllers/bookingController.js'), 'utf8');
  const guards = (src.match(/if \(booking\.source === 'zenoti'\) \{\s*\n\s*return res\.status\(409\)/g) || []).length;
  assert.ok(guards >= 5, `expected unconditional 409 guards on guest cancel/reschedule, admin cancel/reschedule and mark-no-show; found ${guards}`);
  assert.ok(!/source === 'zenoti' && !zenotiWrite\.lifecycleWritebackEnabled\(\)/.test(src), 'guards must not depend on the write-back switch');
  const write = require('fs').readFileSync(require('path').join(__dirname, '../services/zenotiWriteService.js'), 'utf8');
  assert.ok(write.includes("booking.source === 'zenoti' && !['In Progress', 'Completed'].includes(booking.status)"), 'write-back policy for Zenoti rows must be attendance-only');
});

test('Zenoti shifts only narrow panel hours; they never extend them', () => {
  const { clipRangesToShifts } = require('../services/zenotiPractitionerService');
  assert.deepEqual(clipRangesToShifts([{ start: '10:00', end: '13:00' }, { start: '14:00', end: '19:00' }], [{ start: '10:00', end: '18:00' }]),
    [{ start: '10:00', end: '13:00' }, { start: '14:00', end: '18:00' }]);
  assert.deepEqual(clipRangesToShifts([{ start: '11:00', end: '14:00' }], [{ start: '09:00', end: '20:00' }]), [{ start: '11:00', end: '14:00' }]);
  assert.deepEqual(clipRangesToShifts([{ start: '11:00', end: '14:00' }], [{ start: '15:00', end: '17:00' }]), []);
  const src = require('fs').readFileSync(require('path').join(__dirname, '../services/zenotiPractitionerService.js'), 'utf8');
  assert.ok(!/unavailable: true, ranges: \[\], note: 'Not rostered/.test(src), 'the roster sync must never close a day on Zenoti silence');
});

test('centre diary reads ask Zenoti for one day past the inclusive window (end_date is exclusive)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../services/zenotiService.js'), 'utf8');
  assert.ok(src.includes('endExclusive.setUTCDate(endExclusive.getUTCDate() + 1)'), 'getCenterAppointments must add a day to end_date');
});

test('inbound reconcile never blanks the email of an app booking', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../services/zenotiAppointmentSyncService.js'), 'utf8');
  assert.ok(src.includes("booking.source === 'zenoti' && (!booking.email || isPlaceholderEmail(booking.email))"), 'blank email only for Zenoti-owned rows');
});
