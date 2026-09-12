const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const PackageAssignment = require('../models/PackageAssignment');
const Booking = require('../models/Booking');
const { treatingDoctorFor, packageConsultEligibility, describe } = require('../utils/packageConsult');

/**
 * The free consultation that comes with an ongoing package.
 *
 * Two rules are pinned here because both are easy to get subtly wrong and
 * nothing else would notice: WHO the consultation is with (the treating
 * dermatologist, resolved in a fixed order of evidence) and WHEN the package
 * still includes one (the guest-facing reasons when it does not).
 *
 * No database: the Doctor and Booking lookups are injected.
 */

const oid = () => new mongoose.Types.ObjectId();
const day = (n) => new Date(Date.UTC(2026, 8, n));

/** A fake Doctor collection: `findOne({ doctorId })` returns the active profile. */
function doctors(rows) {
  return {
    findOne: async ({ doctorId }) => rows.find((d) => d.doctorId === doctorId && d.isActive !== false) || null,
  };
}
/** A fake Booking collection with the chainable query the util uses. */
function bookings(last) {
  const q = { sort: () => q, select: () => q, lean: async () => last };
  return { findOne: () => q };
}
const DR_A = { doctorId: 'anita-rao', name: 'Dr Anita Rao', tier: 'senior-consultant', level: 'senior', isActive: true };
const DR_B = { doctorId: 'bala-menon', name: 'Dr Bala Menon', tier: 'consultant-dermatologist', level: 'dermatologist', isActive: true };
const DR_GONE = { doctorId: 'gone-doc', name: 'Dr Gone', tier: 'consultant-dermatologist', level: 'dermatologist', isActive: false };

const session = (specialistId, status, date = null) => ({ serviceId: 'exosome', serviceName: 'Exosome', specialistId, status, scheduledDate: date });

function assignment(over = {}) {
  return new PackageAssignment({
    userId: oid(),
    packageId: oid(),
    packageDetails: { packageName: 'Exosome 3 session', services: [{ serviceId: 'exosome', serviceName: 'Exosome', sessions: 3 }] },
    pricing: { originalAmount: 57600 },
    status: 'Active',
    validUntil: new Date(Date.now() + 90 * 86400000),
    sessions: [session(null, 'Scheduled'), session(null, 'Scheduled'), session(null, 'Scheduled')],
    ...over,
  });
}

test('the latest open session names the treating dermatologist', async () => {
  const a = assignment({ sessions: [
    session('bala-menon', 'Completed', day(1)),
    session('anita-rao', 'Booked', day(10)),
    session('bala-menon', 'Scheduled', day(5)), // earlier date, later row — still older
  ] });
  const r = await treatingDoctorFor(a, { Doctor: doctors([DR_A, DR_B]), Booking: bookings(null) });
  assert.equal(r.doctor.doctorId, 'anita-rao');
  assert.equal(r.reason, 'session');
});

test('an undated open session sorts oldest; among equals the later row wins', async () => {
  const a = assignment({ sessions: [
    session('anita-rao', 'Scheduled', null),
    session('bala-menon', 'Scheduled', day(3)),
  ] });
  const r = await treatingDoctorFor(a, { Doctor: doctors([DR_A, DR_B]), Booking: bookings(null) });
  assert.equal(r.doctor.doctorId, 'bala-menon');

  const b = assignment({ sessions: [session('anita-rao', 'Scheduled'), session('bala-menon', 'Scheduled')] });
  assert.equal((await treatingDoctorFor(b, { Doctor: doctors([DR_A, DR_B]), Booking: bookings(null) })).doctor.doctorId, 'bala-menon');
});

test('with no open session, the dermatologist who ran most sessions is the one', async () => {
  const a = assignment({ sessions: [
    session('anita-rao', 'Completed', day(1)),
    session('bala-menon', 'Completed', day(2)),
    session('anita-rao', 'Completed', day(3)),
    session('bala-menon', 'Cancelled', day(4)),
    session('anita-rao', 'Cancelled', day(5)),
  ] });
  const r = await treatingDoctorFor(a, { Doctor: doctors([DR_A, DR_B]), Booking: bookings(null) });
  assert.equal(r.doctor.doctorId, 'anita-rao');
  assert.equal(r.reason, 'sessions');
});

test('sessions with nobody on them fall back to the last completed consultation', async () => {
  const a = assignment();
  let asked = null;
  const Booking = {
    findOne: (query) => { asked = query; return bookings({ specialistId: 'bala-menon' }).findOne(); },
  };
  const r = await treatingDoctorFor(a, { userId: a.userId, Doctor: doctors([DR_A, DR_B]), Booking });
  assert.equal(r.doctor.doctorId, 'bala-menon');
  assert.equal(r.reason, 'history');
  assert.equal(String(asked.userId), String(a.userId));
  assert.equal(asked.status, 'Completed', 'only a visit that happened counts');
});

test('a dermatologist who has left is skipped, not returned', async () => {
  // Open session with a retired profile, most-frequent is also retired,
  // history names someone still here.
  const a = assignment({ sessions: [session('gone-doc', 'Booked', day(9)), session('gone-doc', 'Completed', day(1))] });
  const r = await treatingDoctorFor(a, { userId: a.userId, Doctor: doctors([DR_A, DR_GONE]), Booking: bookings({ specialistId: 'anita-rao' }) });
  assert.equal(r.doctor.doctorId, 'anita-rao');
  assert.equal(r.reason, 'history');
});

test('nobody on record → null, so the app lets the guest choose', async () => {
  const a = assignment();
  const r = await treatingDoctorFor(a, { userId: a.userId, Doctor: doctors([DR_A]), Booking: bookings(null) });
  assert.deepEqual(r, { doctor: null, reason: null });
});

test('an ongoing package includes a free consultation', () => {
  const r = packageConsultEligibility(assignment(), { branchId: oid() });
  assert.deepEqual(r, { ok: true, code: null, message: null });
});

test('an expired package no longer includes one, in words a guest can read', () => {
  const a = assignment({ validUntil: new Date(Date.now() - 86400000) });
  const r = packageConsultEligibility(a, {});
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PACKAGE_EXPIRED');
  assert.equal(r.message, 'This package has ended, so a free consultation is no longer included.');
});

test('cancelled, completed and frozen packages each get their own reason', () => {
  assert.match(packageConsultEligibility(assignment({ status: 'Cancelled' }), {}).message, /was cancelled/);
  assert.match(packageConsultEligibility(assignment({ status: 'Completed' }), {}).message, /Every session .* has been used/);
  const frozen = assignment({ freeze: { isFrozen: true, frozenAt: new Date(), frozenBy: 'desk', reason: 'travel', resumeOn: null } });
  const r = packageConsultEligibility(frozen, {});
  assert.equal(r.code, 'PACKAGE_FROZEN');
  assert.match(r.message, /frozen/);
  assert.doesNotMatch(r.message, /Unfreeze it first/, 'the desk wording must not leak to the guest');
});

test('a package sold for another centre cannot raise the consultation here', () => {
  const here = oid(); const there = oid();
  const a = assignment({ terms: { redeemableScope: 'centres', redeemableBranchIds: [String(here)] } });
  assert.equal(packageConsultEligibility(a, { branchId: here }).ok, true);
  const r = packageConsultEligibility(a, { branchId: there });
  assert.equal(r.code, 'PACKAGE_WRONG_CENTRE');
  assert.match(r.message, /centre it was sold for/);
});

test('every session used but not yet closed counts as no sessions left', () => {
  const a = assignment({ sessions: [session('anita-rao', 'Completed'), session('anita-rao', 'Completed'), session('anita-rao', 'Completed')] });
  const r = packageConsultEligibility(a, {});
  assert.equal(r.code, 'PACKAGE_NO_SESSIONS_LEFT');
  assert.match(r.message, /no longer included/);
});

test('describe() names the package from the sale-time snapshot', () => {
  assert.equal(describe(assignment()), 'Exosome 3 session');
  assert.equal(describe(assignment({ packageDetails: {} })), 'your package');
});

test('the booking model can mark the consultation, without making it a package session', () => {
  const b = new Booking({
    userId: oid(), consultationId: oid(), fullName: 'G', mobileNumber: '9', email: 'g@x.in',
    preferredLocation: 'Jubilee Hills', preferredDate: new Date(), preferredTimeSlots: ['10:00'],
    amount: 0, consultContext: 'package_support', packageAssignmentId: oid(), packageSessionId: null, isPackageIncluded: false,
  });
  assert.equal(b.validateSync(), undefined);
  assert.equal(b.consultContext, 'package_support');
  assert.equal(b.packageSessionId, null, 'no session id → lifecycle side-effects leave the package balance alone');
  assert.equal(b.isPackageIncluded, false);
  const bad = new Booking({ consultContext: 'anything-else' });
  assert.ok(bad.validateSync()?.errors?.consultContext, 'only the known context is accepted');
});
