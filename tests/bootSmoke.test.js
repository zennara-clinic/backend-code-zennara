const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/**
 * Every module must load.
 *
 * On 2026-09-07 production returned 502 for hours: `routes/adminProducts.js`
 * referenced `adminProductController` where the module was bound to
 * `productCtrl`, so requiring the file threw a ReferenceError, the app died
 * during startup, PM2 restart-looped and nginx had nothing to proxy to. Every
 * request in the panel and the app failed — and the browser reported it as a
 * CORS error, because an nginx 502 page carries no Access-Control headers,
 * which sent the diagnosis in the wrong direction entirely.
 *
 * Nothing caught it: a route wired to an undefined name is invisible to the
 * unit tests (they never require the route file) and only fails at boot. This
 * test requires every server module the way the server does, so the same class
 * of mistake fails here instead of in production.
 */

const ROOT = path.join(__dirname, '..');
const DIRS = ['routes', 'controllers', 'services', 'utils', 'models', 'middleware', 'config'];

const jsFiles = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) out.push(full);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
};

test('every route, controller, service, model, middleware and config module loads', () => {
  const failures = [];
  for (const dir of DIRS) {
    for (const file of jsFiles(path.join(ROOT, dir))) {
      try {
        require(file);
      } catch (error) {
        failures.push(`${path.relative(ROOT, file)} — ${error.message.split('\n')[0]}`);
      }
    }
  }
  assert.deepEqual(failures, [], `these modules throw when required, which kills the server at boot:\n  ${failures.join('\n  ')}`);
});

test('routes only mount handlers that actually exist', () => {
  /*
   * A route wired to `undefined` does not throw at load — Express accepts it
   * and the request 500s at runtime instead, which is worse than a boot
   * failure because it looks healthy. Walk each router's stack and check that
   * every layer really holds a function.
   */
  const broken = [];
  for (const file of jsFiles(path.join(ROOT, 'routes'))) {
    let router;
    try { router = require(file); } catch { continue; } // covered by the test above
    const layers = router?.stack;
    if (!Array.isArray(layers)) continue;
    for (const layer of layers) {
      const handlers = layer.route ? layer.route.stack : [];
      for (const h of handlers) {
        if (typeof h.handle !== 'function') {
          broken.push(`${path.relative(ROOT, file)} ${layer.route?.path ?? '?'} — handler is ${typeof h.handle}`);
        }
      }
    }
  }
  assert.deepEqual(broken, [], `these routes are mounted on something that is not a function:\n  ${broken.join('\n  ')}`);
});
