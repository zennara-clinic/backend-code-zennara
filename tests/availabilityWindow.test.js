const test = require('node:test');
const assert = require('node:assert/strict');

const zenoti = require('../services/zenotiService');
const availability = require('../services/zenotiAvailabilityService');

/*
 * Zenoti's roster endpoint refuses a span longer than 30 days, and the app's
 * calendar asks for sixty. Every one of those calls used to 400, the app left
 * its open/closed map empty, and so no date was ever greyed — a guest could
 * tap three weeks out and only discover it was dead once the day's own slot
 * call returned nothing. Long spans are now composed from windows the API
 * accepts, so this pins both the splitting and the merge.
 */

const CENTRE = 'c9f032b2-4450-4a77-8ec8-641a26908d39';

/** Stub the roster endpoint and record exactly which windows were asked for. */
function captureWindows(shiftsFor = () => []) {
  const original = zenoti.getCenterEmployeeSchedules;
  const asked = [];
  zenoti.getCenterEmployeeSchedules = async (centerId, { from, to }) => {
    const span = Math.round((new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`)) / 86400000) + 1;
    asked.push({ from, to, span });
    // The real API answers 400 past 30 days; fail loudly if we ever ask for more.
    assert.ok(span <= 30, `asked Zenoti for ${span} days — it refuses anything over 30`);
    return shiftsFor(from, to);
  };
  return { asked, restore: () => { zenoti.getCenterEmployeeSchedules = original; } };
}

test('a 61-day roster request is split into windows Zenoti accepts', async (t) => {
  const cap = captureWindows();
  t.after(cap.restore);
  // A distinct centre id per test keeps the service's own promise cache out of it.
  await availability.centerSchedule(`${CENTRE}-split`, '2030-01-01', '2030-03-02');
  assert.ok(cap.asked.length > 1, 'a 61-day span must be more than one call');
  assert.ok(cap.asked.every((w) => w.span <= 30));
  assert.equal(cap.asked[0].from, '2030-01-01', 'the first window starts where asked');
  assert.equal(cap.asked[cap.asked.length - 1].to, '2030-03-02', 'the last window ends where asked');
  // No gaps and no overlaps: each window starts the day after the previous ends.
  for (let i = 1; i < cap.asked.length; i += 1) {
    const prevEnd = new Date(`${cap.asked[i - 1].to}T00:00:00Z`);
    const thisStart = new Date(`${cap.asked[i].from}T00:00:00Z`);
    assert.equal((thisStart - prevEnd) / 86400000, 1, 'windows must be contiguous');
  }
});

test('a short request is still a single call', async (t) => {
  const cap = captureWindows();
  t.after(cap.restore);
  await availability.centerSchedule(`${CENTRE}-short`, '2030-01-01', '2030-01-20');
  assert.equal(cap.asked.length, 1);
  assert.deepEqual(cap.asked[0], { from: '2030-01-01', to: '2030-01-20', span: 20 });
});

test('shifts from every window are merged under one employee', async (t) => {
  const cap = captureWindows((from) => [
    { employeeId: 'emp-1', name: 'Dr One', shifts: [{ date: from, start: `${from}T11:00:00`, end: `${from}T18:00:00`, status: 0 }] },
    // A second person appears only in the later windows, as a new joiner would.
    ...(from > '2030-01-15' ? [{ employeeId: 'emp-2', name: 'Dr Two', shifts: [{ date: from, start: `${from}T11:00:00`, end: `${from}T15:00:00`, status: 0 }] }] : []),
  ]);
  t.after(cap.restore);

  const rows = await availability.centerSchedule(`${CENTRE}-merge`, '2030-01-01', '2030-03-02');
  const one = rows.find((r) => r.employeeId === 'emp-1');
  const two = rows.find((r) => r.employeeId === 'emp-2');
  assert.ok(one && two, 'both employees survive the merge');
  assert.equal(one.shifts.length, cap.asked.length, 'one shift per window, all kept');
  assert.equal(one.name, 'Dr One', 'the row keeps its other fields');
  assert.ok(two.shifts.length >= 1 && two.shifts.length < one.shifts.length,
    'someone present in only some windows keeps only those shifts');
});
