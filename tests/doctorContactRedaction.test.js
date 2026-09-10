const test = require('node:test');
const assert = require('node:assert');
const redact = require('../middleware/doctorContactRedaction');
const { usageFromZenoti } = require('../services/zenotiAssignmentMirror');

/**
 * A dermatologist login never receives a guest's phone or email; everyone else
 * gets the response untouched. And a mirrored Zenoti package's counter comes
 * from Zenoti's own per-service lines.
 */

const respond = (req, body) => {
  const out = { json: undefined, sent: undefined, headers: {} };
  const res = {
    get: (k) => out.headers[k.toLowerCase()],
    set: (k, v) => { out.headers[k.toLowerCase()] = v; return res; },
    send: (b) => { out.sent = b; return res; },
    json: (b) => { out.json = b; return res; },
  };
  redact(req, res, () => {});
  res.json(body);
  return out;
};

const guest = () => ({
  success: true,
  data: {
    fullName: 'Kiran Kolli',
    patientId: 'ZENBQ6EX',
    phone: '9000661144',
    email: 'kiran@example.com',
    bookings: [{ mobileNumber: '9000661144', email: 'kiran@example.com', status: 'Completed' }],
    form: { phoneNumber: '9000661144', drugAllergies: 'None' },
    consent: { mobile: '9000661144' },
    zenoti: { profile: { phone: '9000661144', email: 'k@z.com', name: 'Kiran' } },
    order: { shippingAddress: { phone: '9000661144', city: 'Hyderabad' } },
  },
});

test('a dermatologist gets no guest phone or email, anywhere in the payload', () => {
  const out = respond({ admin: { role: 'doctor' }, originalUrl: '/api/admin/users/6a8b0f936b92dc1116c5fd0c' }, guest());
  assert.strictEqual(out.json, undefined, 'went through the redacting path');
  const text = out.sent;
  assert.ok(!text.includes('9000661144'));
  assert.ok(!text.includes('@example.com') && !text.includes('k@z.com'));
  const body = JSON.parse(text);
  assert.strictEqual(body.data.fullName, 'Kiran Kolli');
  assert.strictEqual(body.data.patientId, 'ZENBQ6EX');
  assert.strictEqual(body.data.bookings[0].status, 'Completed');
  assert.strictEqual(body.data.form.drugAllergies, 'None');
  assert.strictEqual(body.data.order.shippingAddress.city, 'Hyderabad');
  assert.strictEqual(out.headers['content-type'], 'application/json');
});

test('documents with toJSON (Mongoose) are redacted too', () => {
  const doc = { toJSON: () => ({ fullName: 'A', phone: '1234567890', email: 'a@b.c' }) };
  const out = respond({ admin: { role: 'doctor' }, originalUrl: '/api/pre-consult-forms/x' }, { data: doc });
  assert.deepStrictEqual(JSON.parse(out.sent), { data: { fullName: 'A' } });
});

test('other roles are untouched', () => {
  for (const role of ['super_admin', 'admin', 'staff', 'therapist']) {
    const body = guest();
    const out = respond({ admin: { role }, originalUrl: '/api/admin/users/x' }, body);
    assert.strictEqual(out.json, body);
  }
  const anon = guest();
  assert.strictEqual(respond({ originalUrl: '/api/auth/me' }, anon).json, anon);
});

test("the dermatologist's own sign-in and profile keep their own contact", () => {
  for (const url of ['/api/admin/auth/me', '/api/admin/auth/verify-otp', '/api/doctors/me', '/api/doctors/abc123', '/api/doctors?x=1', '/api/doctor-fee-requests/mine']) {
    const body = { admin: { email: 'derm@zennara.in', phone: '9999999999' } };
    assert.strictEqual(respond({ admin: { role: 'doctor' }, originalUrl: url }, body).json, body, url);
  }
  const list = respond({ admin: { role: 'doctor' }, originalUrl: '/api/doctors/me/patients?page=1' }, { data: [{ fullName: 'A', phone: '1' }] });
  assert.deepStrictEqual(JSON.parse(list.sent), { data: [{ fullName: 'A' }] }, 'the patients list is guest data');
});

test('usageFromZenoti counts a clinic package the way Zenoti does', () => {
  // Kiran Kolli's 5 BODY PARTS PACKAGE on prod, 2026-09-10.
  const zp = { services: [
    { name: 'LHR bikini', total: 5, used: 3, balance: 2 },
    { name: 'LHR under arms', total: 5, used: 3, balance: 2 },
    { name: 'LHR full arms', total: 5, used: 1, balance: 4 },
    { name: 'LHR full legs', total: 5, used: 4, balance: 1 },
    { name: 'LHR Upper Lip/Nose', total: 5, used: 5, balance: 0 },
  ] };
  assert.deepStrictEqual(usageFromZenoti(zp), { totalSessions: 25, usedSessions: 16, remainingSessions: 9 });
  assert.deepStrictEqual(usageFromZenoti({ services: [] }), { totalSessions: 0, usedSessions: 0, remainingSessions: 0 });
  assert.deepStrictEqual(usageFromZenoti({ services: [{ total: 3, used: 1 }] }), { totalSessions: 3, usedSessions: 1, remainingSessions: 2 });
  assert.deepStrictEqual(usageFromZenoti({ services: [{ total: 4, balance: 1 }] }), { totalSessions: 4, usedSessions: 3, remainingSessions: 1 });
});
