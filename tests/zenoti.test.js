const test = require('node:test');
const assert = require('node:assert/strict');

const zenoti = require('../services/zenotiService');
const { isMembershipCurrentlyActive } = require('../services/zenotiSyncService');
const { isZenMembership } = require('../config/zenoti');
const { statusOf } = require('../services/zenotiMembershipMirror');
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

/*
 * The clinic sells ONE membership, but Zenoti carries it under every name it
 * has ever had. Matching only on "zen" left the 26 guests on MVP-2026 / MVP Jh
 * out of the Zen Member tier entirely, and their memberships out of the panel.
 */
test('every Zenoti name the one membership is sold under counts as Zen', () => {
  for (const name of ['Zen Membership', 'Zen Membership Programme', 'MVP', 'MVP-2026', 'MVP Jh', 'NEW MVP']) {
    assert.equal(isZenMembership(name), true, `${name} should be the Zen membership`);
  }
  // Codes carry it too — a guest's row is coded MVPJH / Zen member123.
  for (const code of ['MVPJH', 'Zen member123', 'Zenmember02']) {
    assert.equal(isZenMembership(code), true, `${code} should be the Zen membership`);
  }
  // The discount tiers in Zenoti that were never sold are NOT the membership.
  for (const other of ['Zennara Essential – 20% OFF', 'Zennara Prime – 30% OFF', 'Platinum Membership – 40% off']) {
    assert.equal(isZenMembership(other), false, `${other} is not the Zen membership`);
  }
});

test('mirrored membership status follows Zenoti, then the expiry, then refunds', () => {
  const future = '2099-01-01', past = '2020-01-01';
  assert.equal(statusOf({ status: 1, expiryDate: future }), 'Active');
  assert.equal(statusOf({ status: 5, expiryDate: past }), 'Expired');
  // Zenoti says expired but the date has not passed — Zenoti wins.
  assert.equal(statusOf({ status: 5, expiryDate: future }), 'Expired');
  // Zenoti says active but the date has passed — the date wins.
  assert.equal(statusOf({ status: 1, expiryDate: past }), 'Expired');
  // A refund cancels it whatever the dates say.
  assert.equal(statusOf({ status: 1, expiryDate: future, isRefunded: true }), 'Cancelled');
});

test('normalized membership carries the Zenoti product id for price lookup', () => {
  const m = zenoti.normalizeMembership({
    user_membership_id: 'um-1', status: 1, expiry_date: '2099-01-01',
    membership: { id: 'prod-1', name: 'MVP Jh', code: 'MVPJH' },
  });
  assert.equal(m.membershipId, 'prod-1');
  assert.equal(m.id, 'um-1');
});

/*
 * Zenoti answers many failures with HTTP 200 and the error in the body. Two of
 * them bit us on 2026-09-08: "Reopen session" told the desk it had reopened a
 * visit Zenoti had kept closed, and the slot search blamed unpublished rosters
 * for an error Zenoti had actually explained. res.ok is not success.
 */
test('an error inside a 200 response is treated as a failure', () => {
  const src = require('fs').readFileSync(require.resolve('../services/zenotiService.js'), 'utf8');
  const idx = src.indexOf('const embedded =');
  assert.ok(idx > -1, 'the 200-with-error guard must exist');
  const block = src.slice(idx, idx + 700);
  assert.match(block, /json\.error \|\| json\.Error/, 'both casings Zenoti uses must be checked');
  assert.match(block, /throw new ZenotiError/, 'a populated error must throw');
  // …but an empty `error: null` is normal and must NOT throw.
  assert.match(block, /message \|\| code/, 'only a populated error object counts');
});

test('cancel sends its payload in the body, not the query string', () => {
  const src = require('fs').readFileSync(require.resolve('../services/zenotiWriteService.js'), 'utf8');
  const i = src.indexOf("cancelAppointment");
  const block = src.slice(i, i + 400);
  assert.match(block, /body: \{/, 'as query params Zenoti answers "invalid reason_id"');
  assert.doesNotMatch(block, /query: \{\s*\n\s*comments/, 'comments must not go back into the query string');
});

/*
 * Zenoti does not always move the appointment status when a guest arrives — a
 * check-in taken at the desk can leave it on 0 (Booked) with only a
 * checkin_time set. One such visit sat at Financial District on 2026-09-09:
 * the arrival time was mirrored, but the day book read "Confirmed", so the
 * desk could not see the guest was in the building.
 */
test('an arrival recorded by Zenoti counts as checked in, whatever the enum says', () => {
  const { localStatus } = require('../services/zenotiAppointmentSyncService');
  assert.equal(localStatus({ status: 0, progress: 0 }), 'Confirmed');
  assert.equal(localStatus({ status: 0, progress: 0, checkinTime: '2026-09-09T11:00:00' }), 'Checked In');
  // A later state must still win over the arrival stamp.
  assert.equal(localStatus({ status: 4, progress: 0, checkinTime: 'x' }), 'In Progress');
  assert.equal(localStatus({ status: 1, progress: 2, checkinTime: 'x' }), 'Completed');
  assert.equal(localStatus({ status: -1, checkinTime: 'x' }), 'Cancelled');
  assert.equal(localStatus({ status: -2, checkinTime: 'x' }), 'No Show');
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
  // Zenoti 2 = "Checked in" (the guest is here) and 4 = "In service" (the guest
  // is in the room). These were the wrong way round until 2026-09-07, so a
  // checked-in guest showed as being treated and a guest under treatment showed
  // as merely confirmed.
  assert.equal(localStatus({ status: 4, progress: 0 }), 'In Progress');
  assert.equal(localStatus({ status: 2, progress: 0 }), 'Checked In');
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
  assert.ok(guards >= 3, `expected unconditional 409 guards on guest cancel and admin cancel/reschedule; found ${guards}`);
  // No-show, confirm and the undos are guarded centrally instead of inline:
  // one list in the lifecycle service covers every desk action, so a new
  // action cannot be added without deciding whether Zenoti owns it.
  const life = require('fs').readFileSync(require('path').join(__dirname, '../services/bookingLifecycleService.js'), 'utf8');
  assert.ok(/const ZENOTI_OWNED_BLOCKED = new Set\(\['confirm', 'cancel', 'no_show', 'undo_cancel', 'undo_no_show'\]\)/.test(life),
    'the lifecycle service must refuse schedule-changing actions on a Zenoti-booked appointment');
  // Guests no longer reschedule anything from the app — Zenoti-booked or not —
  // so that route needs no source check: it refuses everyone and says to call.
  assert.ok(/RESCHEDULE_AT_CLINIC/.test(src), 'the guest reschedule route must refuse and point at the clinic');
  assert.ok(!/source === 'zenoti' && !zenotiWrite\.lifecycleWritebackEnabled\(\)/.test(src), 'guards must not depend on the write-back switch');
  const write = require('fs').readFileSync(require('path').join(__dirname, '../services/zenotiWriteService.js'), 'utf8');
  // Assert the RULE, not the exact line: attendance may be pushed, scheduling
  // never. Pinning the literal list meant retiring undo_complete (which Zenoti
  // refuses — AA102) broke a test that had nothing to say about that change.
  const allowed = write.match(/ZENOTI_OWNED_ALLOWED = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(allowed, 'the Zenoti-owned allow-list must exist');
  for (const attendance of ['check_in', 'undo_check_in', 'start', 'undo_start', 'complete']) {
    assert.match(allowed[1], new RegExp(`'${attendance}'`), `${attendance} is ours to record`);
  }
  for (const scheduling of ['confirm', 'cancel', 'reschedule', 'no_show']) {
    assert.doesNotMatch(allowed[1], new RegExp(`'${scheduling}'`),
      'write-back for Zenoti-booked rows must be attendance-only (never confirm/cancel/no-show)');
  }
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

test('clinicInstant reads Zenoti wall-clock strings as IST and rejects the 0001 sentinel', () => {
  const { clinicInstant } = require('../config/zenoti');
  assert.equal(clinicInstant('2026-02-04T06:16:07').toISOString(), '2026-02-04T00:46:07.000Z');
  assert.equal(clinicInstant('2026-08-29T06:54:00Z').toISOString(), '2026-08-29T06:54:00.000Z');
  assert.equal(clinicInstant('0001-01-01T00:00:00'), null);
  assert.equal(clinicInstant(null), null);
});

test('centre diary rows carry when and by whom the appointment was booked', () => {
  const row = zenoti.normalizeCenterAppointment({
    appointment_id: 'A1', guest: { id: 'G1', first_name: 'A', last_name: 'B' },
    service: { id: 'S1', name: 'Consultation' }, start_time: '2026-08-29T12:15:00',
    creation_date: '2026-08-29T12:24:00', creation_date_utc: '2026-08-29T06:54:00', created_by_name: 'Front Desk',
  }, 'c9f032b2-4450-4a77-8ec8-641a26908d39');
  assert.equal(row.createdAt, '2026-08-29T12:24:00');
  assert.equal(row.createdAtUtc, '2026-08-29T06:54:00');
  assert.equal(row.createdByName, 'Front Desk');
});

test('a new mirrored booking keeps the Zenoti booked-on instant as createdAt', () => {
  const bookedAt = new Date('2026-08-29T06:54:00Z');
  const booking = new Booking({ createdAt: bookedAt, source: 'zenoti' });
  assert.equal(booking.createdAt.getTime(), bookedAt.getTime());
});

test('diary placeholders are recognised as pseudo-guests, real names are not', () => {
  const { isPseudoGuestName, isPseudoGuest } = require('../utils/zenotiPseudoGuest');
  assert.equal(isPseudoGuestName('Meeting  '), true);
  assert.equal(isPseudoGuestName('Reserved'), true);
  assert.equal(isPseudoGuestName('CRM Booking'), true);
  assert.equal(isPseudoGuestName('Test Guest 2'), true);
  assert.equal(isPseudoGuestName('Meet', 'Patel'), false);
  assert.equal(isPseudoGuestName('Shaminn Santigo'), false);
  assert.equal(isPseudoGuestName('Reserved Reddy'), false);
  // Block-out rows file the block under the therapist's own id as the guest.
  assert.equal(isPseudoGuest({ zenotiGuestId: 'abc', fullName: 'Asha Rao' }, { therapistId: 'ABC' }), true);
  assert.equal(isPseudoGuest({ zenotiGuestId: 'abc', fullName: 'Asha Rao' }, { therapistId: 'xyz' }), false);
});

test('block-out rows normalise to provider blocks, never appointments', () => {
  const raw = {
    appointment_id: '2AF0B2E5-0DBE-434E-BE84-0F0F5BCBB5DC',
    blockout: { id: 3679, name: 'Meeting  ', code: 'Meeting  ', duration: 60, indicator_color: '#8D8DCF' },
    start_time: '2026-09-05T17:00:00', end_time: '2026-09-05T18:45:00', status: 10,
    therapist: { id: '40a360dd-91f2-47f9-bfb7-8d8f55c74012', name: 'Dr.Madhurya' },
    guest: { id: '40a360dd-91f2-47f9-bfb7-8d8f55c74012', first_name: 'Meeting  ', last_name: '' },
    notes: 'Erbium glass demo',
  };
  assert.equal(zenoti.normalizeCenterAppointment(raw, 'c1'), null);
  const block = zenoti.normalizeCenterBlockout(raw, 'c1');
  assert.equal(block.id, '2af0b2e5-0dbe-434e-be84-0f0f5bcbb5dc');
  assert.equal(block.title, 'Meeting');
  assert.equal(block.therapistName, 'Dr.Madhurya');
  assert.equal(block.durationMinutes, 60);
  assert.equal(block.notes, 'Erbium glass demo');
});

test('rx classifier follows the clinic Rx/OTC sheet', () => {
  const { classifyRx } = require('../utils/rxClassifier');
  assert.equal(classifyRx({ name: 'Brintop Diva 5%', category: 'Haircare', subCategory: 'Hair Fall & Growth', hsn: '30049099' }).isRx, true);
  assert.equal(classifyRx({ name: 'Azithral 500mg Tab', category: 'Medicines', subCategory: 'Antibiotic', hsn: '30049099' }).isRx, true);
  assert.equal(classifyRx({ name: 'Tab Depiglow Ultra', category: 'Supplements', subCategory: 'Skin Supplement', hsn: '21069099' }).isRx, true);
  assert.equal(classifyRx({ name: 'Epiduo Gel Forte', category: 'Medicines', subCategory: 'Acne', hsn: '30049099' }).isRx, true);
  assert.equal(classifyRx({ name: 'Isdin Fotofusion Water Magic', category: 'Sun Care', subCategory: 'Sun Protection', hsn: '33049990' }).isRx, false);
  assert.equal(classifyRx({ name: 'Cerave Moisturising Lotion', category: 'Test Category', subCategory: 'None.', hsn: '123' }).isRx, false);
  assert.equal(classifyRx({ name: 'Colave Collagen Drink', category: 'Supplements', subCategory: 'Collagen', hsn: '21069099' }).isRx, false);
  assert.equal(classifyRx({ name: 'Unknown Thing' }).isRx, null);
});

test('combined Zenoti doctor labels resolve to the first named doctor and to all of them', () => {
  const { buildDoctorMatcher, splitCombinedName } = require('../utils/dermatologistMatch');
  assert.deepEqual(splitCombinedName('Dr Varsha-Dr Bandhavi M Sane'), ['Dr Varsha', 'Dr Bandhavi M Sane']);
  assert.deepEqual(splitCombinedName('Dr Shilpa Reddy-Gill'), ['Dr Shilpa Reddy-Gill']);
  const match = buildDoctorMatcher([
    { doctorId: 'varsha-reddy', name: 'Dr Varsha Reddy' },
    { doctorId: 'bandhavi-m-sane', name: 'Dr Bandhavi M Sane' },
    { doctorId: 'shilpa-gill', name: 'Dr Shilpa Gill' },
  ]);
  assert.equal(match('Dr Varsha-Dr Bandhavi M Sane').doctorId, 'varsha-reddy');
  assert.deepEqual(match.matchAll('Dr Varsha-Dr Bandhavi M Sane').map((d) => d.doctorId), ['varsha-reddy', 'bandhavi-m-sane']);
  assert.equal(match('Dr Shilpa Gill').doctorId, 'shilpa-gill');
});

test('package completion counts sessions per service, not services', () => {
  const PackageAssignment = require('../models/PackageAssignment');
  const a = new PackageAssignment({
    packageDetails: { services: [{ serviceId: 'exo', serviceName: 'Exosome', sessions: 3 }, { serviceId: 'gfc', serviceName: 'GFC', sessions: 2 }] },
    sessions: [
      { serviceId: 'exo', status: 'Completed' }, { serviceId: 'gfc', status: 'Completed' },
      { serviceId: 'exo', status: 'Scheduled' }, { serviceId: 'exo', status: 'Scheduled' }, { serviceId: 'gfc', status: 'Scheduled' },
    ],
    status: 'Active',
  });
  assert.equal(a.checkCompletion(), false);
  assert.equal(a.status, 'Active');
  assert.equal(a.getCompletionPercentage(), 40);
  const balances = a.serviceBalances();
  assert.deepEqual(balances.map((b) => [b.serviceId, b.entitled, b.used, b.balance]), [['exo', 3, 1, 2], ['gfc', 2, 1, 1]]);
});

test('service priceAt uses the per-centre row and splits tax', () => {
  const Consultation = require('../models/Consultation');
  const mongoose = require('mongoose');
  const jh = new mongoose.Types.ObjectId();
  const c = new Consultation({ id: 'x', slug: 'x', name: 'X', category: 'Y', summary: 's', about: 'a', price: 28000, taxPercent: 5, priceIncludesTax: true, centrePrices: [{ branchId: jh, price: 35000 }] });
  assert.equal(c.priceAt(jh).total, 35000);
  assert.equal(c.priceAt(jh).base, 33333.33);
  assert.equal(c.priceAt(jh).tax, 1666.67);
  assert.equal(c.priceAt(null).total, 28000);
});
