const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/**
 * Staff sign-in throttling.
 *
 * The bug this file exists for: the limiter counted EVERY request, not just
 * failures, and the same 5-request budget covered five endpoints — including
 * `check-email`, which the panel calls before every single sign-in. Two
 * requests per attempt against a five-request ceiling meant the third
 * SUCCESSFUL login locked a doctor out of their own panel for fifteen minutes.
 *
 * The other half is the pause. Turning brute-force protection off is a real
 * thing to want (you cannot test a panel otherwise) and a dangerous thing to
 * leave on, so it is a deadline rather than a boolean, capped, reasoned and
 * audited.
 */

const ROOT = path.join(__dirname, '..');
const limiter = fs.readFileSync(path.join(ROOT, 'middleware', 'rateLimiter.js'), 'utf8');
const authRoutes = fs.readFileSync(path.join(ROOT, 'routes', 'adminAuth.js'), 'utf8');
const model = fs.readFileSync(path.join(ROOT, 'models', 'SecuritySettings.js'), 'utf8');
const ctrl = fs.readFileSync(path.join(ROOT, 'controllers', 'securitySettingsController.js'), 'utf8');
const routes = fs.readFileSync(path.join(ROOT, 'routes', 'admin', 'securitySettingsRoutes.js'), 'utf8');

/** The body of one `exports.x = rateLimit({ ... })` block. */
const block = (name) => {
  const at = limiter.indexOf(`exports.${name} = rateLimit({`);
  assert.ok(at > -1, `${name} is missing`);
  return limiter.slice(at, limiter.indexOf('});', at));
};

test('a successful sign-in never counts against the limit', () => {
  for (const name of ['adminLoginLimiter', 'adminOTPLimiter']) {
    assert.match(block(name), /skipSuccessfulRequests: true/,
      `${name} must count failures only — a success is not a guess`);
  }
});

test('check-email is not charged to the sign-in budget', () => {
  // The panel calls it before every attempt; sharing the budget halved it.
  assert.match(authRoutes, /router\.post\('\/check-email', adminEmailLookupLimiter/);
  // But it still needs a ceiling, or it enumerates which addresses are staff.
  assert.match(limiter, /exports\.adminEmailLookupLimiter = rateLimit\(\{/);
});

test('one person fat-fingering a password cannot lock out the clinic', () => {
  // Keying on IP alone made a whole office behind one connection share a budget.
  assert.match(limiter, /const perAccountKey = \(req\) => \{[\s\S]*?req\.body\?\.email/);
  for (const name of ['adminLoginLimiter', 'adminEmailLookupLimiter', 'adminOTPLimiter']) {
    assert.match(block(name), /keyGenerator: perAccountKey/, `${name} must key per account`);
  }
  // ipKeyGenerator normalises IPv6 to a /64; raw req.ip lets an attacker walk
  // addresses inside their own prefix.
  assert.match(limiter, /ipKeyGenerator\(req\.ip\)/);
});

test('the pause is a deadline, not a boolean', () => {
  assert.ok(!/enabled:\s*\{\s*type: Boolean/.test(model), 'no on/off flag — it would be found off months later');
  assert.match(model, /pausedUntil/);
  assert.match(model, /MAX_PAUSE_MINUTES = 24 \* 60/);
  // And the controller must actually enforce that ceiling.
  assert.match(ctrl, /minutes > SecuritySettings\.MAX_PAUSE_MINUTES/);
});

test('pausing needs a reason, and is audited as a warning', () => {
  assert.match(ctrl, /reason\.length < 3/, 'a reason is required');
  const pause = ctrl.slice(ctrl.indexOf('const until = new Date'), ctrl.indexOf('exports.lockedAccounts'));
  assert.match(pause, /action: 'SETTINGS_UPDATED', resource: 'SECURITY'/);
  assert.match(pause, /status: 'WARNING'/, 'turning off brute-force protection is not a routine settings change');
});

test('only a super admin can reach any of it', () => {
  assert.match(routes, /requireRole\('super_admin'\)/);
  // By role, not by permission: these switches govern who can get into the
  // panels at all, so they must not be grantable through a custom role.
  assert.ok(!/requirePermission/.test(routes));
});

test('a database failure re-enables the limiter rather than disabling it', () => {
  const refresh = limiter.slice(limiter.indexOf('exports.refreshLoginRateLimitPause'), limiter.indexOf('const loginLimiterPaused'));
  assert.match(refresh, /catch\s*\{[\s\S]*?pausedUntil = null;/,
    'if the setting cannot be read, the limiter must stay ON');
});

test('the pause survives a restart', () => {
  // `skip` is synchronous, so the value is cached in memory. Without priming at
  // boot, a restart would silently re-enable the limiter mid-pause.
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(server, /refreshLoginRateLimitPause\(\)/);
});
