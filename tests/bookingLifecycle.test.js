const test = require('node:test');
const assert = require('node:assert');

const lifecycle = require('../services/bookingLifecycleService');
const { ACTIONS, availableActions, checkInWindow, lifecycleState } = lifecycle;

/** A booking-shaped object good enough for the pure rule functions. */
const booking = (over = {}) => ({
  status: 'Confirmed',
  source: 'app',
  confirmedDate: new Date('2026-09-07T00:00:00+05:30'),
  confirmedTime: '11:00',
  preferredDate: new Date('2026-09-07T00:00:00+05:30'),
  preferredTimeSlots: ['11:00'],
  slotTime: '11:00',
  ...over,
});

/** An instant on the appointment's clinic day, at HH:mm IST. */
const at = (time) => new Date(`2026-09-07T${time}:00+05:30`);

test('the desk actions mirror Zenoti, and every forward step has an undo', () => {
  for (const step of ['check_in', 'start', 'complete', 'no_show', 'cancel']) {
    assert.ok(ACTIONS[`undo_${step === 'check_in' ? 'check_in' : step}`], `${step} needs an undo`);
  }
  // Undoing lands exactly one step back, so the trail is reversible.
  assert.equal(ACTIONS.undo_check_in.to, 'Confirmed');
  assert.equal(ACTIONS.undo_start.to, 'Checked In');
  assert.equal(ACTIONS.undo_complete.to, 'In Progress');
});

test('a guest cannot be checked in an hour early, and can 30 minutes before', () => {
  const b = booking();
  const tooEarly = checkInWindow(b, at('10:00'));
  assert.equal(tooEarly.ok, false);
  assert.equal(tooEarly.code, 'CHECKIN_TOO_EARLY');
  // The desk is told when it opens, not merely that it is closed.
  assert.match(tooEarly.reason, /10:30/);

  assert.equal(checkInWindow(b, at('10:30')).ok, true);
  assert.equal(checkInWindow(b, at('11:05')).ok, true);
});

test('check-in closes long after the slot, so a late guest is still recordable', () => {
  const b = booking();
  assert.equal(checkInWindow(b, at('13:00')).ok, true);
  const shut = checkInWindow(b, at('16:00'));
  assert.equal(shut.ok, false);
  assert.equal(shut.code, 'CHECKIN_TOO_LATE');
});

test('a booking with no fixed time yet has no window to enforce', () => {
  const b = booking({ confirmedTime: null, slotTime: null, preferredTimeSlots: [] });
  assert.equal(checkInWindow(b, at('03:00')).ok, true);
});

test('only the legal next steps are offered for each status', () => {
  assert.deepEqual(availableActions(booking({ status: 'Awaiting Confirmation' })), ['confirm', 'no_show', 'cancel']);
  assert.deepEqual(availableActions(booking({ status: 'Confirmed' })), ['check_in', 'no_show', 'cancel']);
  assert.deepEqual(availableActions(booking({ status: 'Checked In' })), ['start', 'undo_check_in', 'cancel']);
  assert.deepEqual(availableActions(booking({ status: 'In Progress' })), ['complete', 'undo_start']);
  assert.deepEqual(availableActions(booking({ status: 'Completed' })), ['undo_complete']);
  assert.deepEqual(availableActions(booking({ status: 'No Show' })), ['check_in', 'undo_no_show']);
});

test('a Zenoti-booked appointment only offers attendance actions', () => {
  const z = booking({ source: 'zenoti', status: 'Confirmed' });
  assert.deepEqual(availableActions(z), ['check_in']);
  assert.deepEqual(availableActions(booking({ source: 'zenoti', status: 'In Progress' })), ['complete', 'undo_start']);
  // Cancelling, confirming and no-showing stay in Zenoti — see the 2026-09-03
  // incident where automated no-shows were written into the CRM.
  assert.ok(!availableActions(z).includes('cancel'));
  assert.ok(!availableActions(z).includes('no_show'));
});

test('the panel is told a blocked check-in is overridable, and needs a reason', () => {
  const state = lifecycleState(booking(), at('09:00'));
  const checkIn = state.actions.find((a) => a.action === 'check_in');
  assert.equal(checkIn.blocked, true);
  assert.equal(checkIn.overridable, true);
  assert.equal(checkIn.needsReason, true);
  assert.equal(state.earlyMinutes, 30);

  const open = lifecycleState(booking(), at('10:45')).actions.find((a) => a.action === 'check_in');
  assert.equal(open.blocked, false);
  assert.equal(open.needsReason, false);
});

test('undo no show is flagged local-only — Zenoti exposes no such route', () => {
  const undo = lifecycleState(booking({ status: 'No Show' })).actions.find((a) => a.action === 'undo_no_show');
  assert.equal(undo.localOnly, true);
  assert.equal(ACTIONS.undo_no_show.zenoti, null);
});

test('reopening a completed visit demands a reason', () => {
  assert.equal(ACTIONS.undo_complete.needsReason, true);
  assert.equal(ACTIONS.undo_complete.sameDayOnly, true);
});

test('logStatus appends one readable audit row', () => {
  const b = { status: 'Checked In', statusLog: [] };
  lifecycle.logStatus(b, { action: 'check_in', from: 'Confirmed', to: 'Checked In', admin: { _id: 'a1', name: 'Asha' } });
  assert.equal(b.statusLog.length, 1);
  assert.equal(b.statusLog[0].byName, 'Asha');
  assert.equal(b.statusLog[0].from, 'Confirmed');
  assert.equal(b.statusLog[0].to, 'Checked In');
});

test('every lifecycle action names a Zenoti call, or explicitly none', () => {
  const write = require('fs').readFileSync(require('path').join(__dirname, '../services/zenotiWriteService.js'), 'utf8');
  for (const [name, spec] of Object.entries(ACTIONS)) {
    if (spec.zenoti === null) continue;
    assert.ok(new RegExp(`^  ${spec.zenoti}:`, 'm').test(write),
      `${name} claims Zenoti call "${spec.zenoti}" but LIFECYCLE_CALLS has no such entry`);
  }
});

test('the visit-code flow is gone from the booking surface', () => {
  const fs = require('fs');
  const path = require('path');
  assert.equal(fs.existsSync(path.join(__dirname, '../utils/visitCodes.js')), false, 'utils/visitCodes.js must be deleted');
  const model = fs.readFileSync(path.join(__dirname, '../models/Booking.js'), 'utf8');
  for (const field of ['checkInCode', 'checkOutCode', 'visitCodeLog', 'manualCheckIn']) {
    assert.ok(!model.includes(field), `Booking still carries ${field}`);
  }
  const routes = fs.readFileSync(path.join(__dirname, '../routes/booking.js'), 'utf8');
  assert.ok(routes.includes('VISIT_CODES_RETIRED'), 'old code routes must answer 410, not 404');
});

test('status filters include the new Checked In state everywhere they matter', () => {
  const s = require('../utils/bookingStatuses');
  for (const key of ['LIVE', 'UPCOMING', 'ATTENDED', 'PRESENT', 'BLOCKING', 'COUNTABLE']) {
    assert.ok(s[key].includes('Checked In'), `${key} must count a checked-in guest`);
  }
  assert.ok(!s.PAST.includes('Checked In'));
});
