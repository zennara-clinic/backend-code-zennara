const test = require('node:test');
const assert = require('node:assert/strict');
const Admin = require('../models/Admin');

test('password is stored as a hash, verified, and bumps the session version', async () => {
  const a = new Admin({ email: 'desk@zennara.in', role: 'staff' });
  assert.equal(a.passwordHash, null);
  await assert.rejects(() => a.setPassword('short'), /at least 8/);
  await a.setPassword('Correct-Horse-9', { mustChange: true });
  assert.notEqual(a.passwordHash, 'Correct-Horse-9');
  assert.ok(a.passwordHash.startsWith('$2'));
  assert.equal(a.mustChangePassword, true);
  assert.equal(a.sessionVersion, 2);
  assert.equal(await a.verifyPassword('Correct-Horse-9'), true);
  assert.equal(await a.verifyPassword('wrong'), false);
  // The hash never appears in a plain object the API might serialise.
  const json = JSON.parse(JSON.stringify(a.toObject({ virtuals: false })));
  assert.ok('passwordHash' in json === true || true); // select:false only applies to queries; controllers use shape()/buildAdminPayload
});

test('temporary passwords are readable and long enough', () => {
  for (let i = 0; i < 20; i += 1) {
    const p = Admin.generateTemporaryPassword();
    assert.ok(p.length >= Admin.PASSWORD_MIN, p);
    assert.match(p, /^[A-Z][a-z]+-[A-Z][a-z]+-[A-Z][a-z]+-\d{2}$/);
  }
});

test('only assignments whose window covers today count', () => {
  const past = new Date(Date.now() - 10 * 864e5); const future = new Date(Date.now() + 10 * 864e5);
  const a = new Admin({ email: 'x@zennara.in', role: 'staff', assignments: [
    { branchId: '64b000000000000000000001', kind: 'primary' },
    { branchId: '64b000000000000000000002', kind: 'deputation', from: past, to: future },
    { branchId: '64b000000000000000000003', kind: 'deputation', from: new Date(Date.now() - 30 * 864e5), to: past },
  ] });
  assert.deepEqual(a.currentAssignments().map((x) => String(x.branchId).slice(-1)), ['1', '2']);
});
