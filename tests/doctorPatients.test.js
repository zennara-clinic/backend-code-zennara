const test = require('node:test');
const assert = require('node:assert');
const { doctorBookingMatch } = require('../utils/doctorPatients');

/*
 * Which bookings are a dermatologist's. It decides their patient list and
 * their diary, so a wrong rule either hides guests (the "0 under your care"
 * bug) or shows one dermatologist's guests in another's panel.
 */

test('a linked dermatologist matches their profile id or their Zenoti employee id', () => {
  const m = doctorBookingMatch({ doctorId: 'Spoorthy-Nagineni', zenotiEmployeeId: 'ABC-123' });
  assert.deepStrictEqual(m, {
    $or: [
      { specialistId: 'spoorthy-nagineni' },
      { zenotiTherapistId: 'abc-123', specialistId: { $in: [null, '', 'spoorthy-nagineni'] } },
    ],
  });
});

test('a Zenoti visit reassigned to another dermatologist is not taken by the employee id', () => {
  const m = doctorBookingMatch({ doctorId: 'a', zenotiEmployeeId: 'emp' });
  const byEmployee = m.$or[1];
  // specialistId "b" is not in the allowed list, so that row stays in b's diary only.
  assert.ok(!byEmployee.specialistId.$in.includes('b'));
});

test('without a Zenoti link it is just the profile id', () => {
  assert.deepStrictEqual(doctorBookingMatch({ doctorId: 'meghana' }), { specialistId: 'meghana' });
});

test('no identity at all matches nothing, rather than everything', () => {
  assert.deepStrictEqual(doctorBookingMatch({}), { _id: { $exists: false } });
  assert.deepStrictEqual(doctorBookingMatch(null), { _id: { $exists: false } });
});
