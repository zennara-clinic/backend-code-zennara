const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/**
 * Saved prescriptions — the "Favourites" shelf in the prescription builder.
 *
 * The risk here is not the CRUD, it is what a saved prescription is allowed to
 * become. A favourite is a set of LINES, never a patient and never a
 * signature: it must not carry per-guest state into someone else's record, it
 * must not let one dermatologist edit another's, and saving one must never be
 * mistaken for prescribing one.
 */

const ROOT = path.join(__dirname, '..');
const model = fs.readFileSync(path.join(ROOT, 'models', 'RxFavourite.js'), 'utf8');
const ctrl = fs.readFileSync(path.join(ROOT, 'controllers', 'rxFavouriteController.js'), 'utf8');
const routes = fs.readFileSync(path.join(ROOT, 'routes', 'rxFavourite.js'), 'utf8');

test('a saved prescription carries no per-guest state', () => {
  /*
   * availableQuantity is the stock at the moment of prescribing and
   * refillReminderSentAt is a nudge already sent to one person. Copying either
   * into a template would put one guest's facts on the next guest's slip.
   *
   * Asserted against the compiled schema paths rather than the source text —
   * grepping the file matched the comment that explains the rule.
   */
  process.env.ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET || 'test-secret-for-rx-spec';
  const RxFavourite = require('../models/RxFavourite');
  const paths = new Set(Object.keys(RxFavourite.schema.paths));
  const itemPaths = new Set(Object.keys(RxFavourite.schema.path('items').schema.paths));
  for (const leak of ['availableQuantity', 'refillReminderSentAt', 'userId', 'bookingId']) {
    assert.ok(!paths.has(leak), `RxFavourite must not store ${leak}`);
    assert.ok(!itemPaths.has(leak), `a saved line must not store ${leak}`);
  }
  assert.ok(paths.has('ownerId'), 'a favourite belongs to the dermatologist who saved it');
  assert.ok(paths.has('scope'), 'and says whether it is shared with the clinic');
});

test('the saved lines match the shape a real prescription uses', () => {
  // If these drift, adding a favourite silently drops fields off the slip.
  const noteModel = fs.readFileSync(path.join(ROOT, 'models', 'ConsultationNote.js'), 'utf8');
  const item = noteModel.slice(noteModel.indexOf('const prescriptionItemSchema'), noteModel.indexOf('const consultationNoteSchema'));
  const shared = ['medicine', 'strength', 'formulation', 'dosage', 'frequency', 'duration', 'timing', 'instructions', 'productId', 'isScheduleH', 'refillAfterDays'];
  for (const field of shared) {
    assert.ok(item.includes(`${field}:`), `prescriptionItemSchema lost ${field}`);
    assert.ok(model.includes(`${field}:`), `RxFavourite lost ${field}`);
  }
  // And the controller must not silently pass through anything else.
  const list = ctrl.slice(ctrl.indexOf('const ITEM_FIELDS'), ctrl.indexOf('const cleanItems'));
  for (const field of shared) assert.ok(list.includes(`'${field}'`), `ITEM_FIELDS is missing ${field}`);
});

test('only the owner can change or retire a favourite, whatever its scope', () => {
  // Sharing a protocol with the clinic must not hand over authorship.
  for (const fn of ['exports.update', 'exports.remove']) {
    const body = ctrl.slice(ctrl.indexOf(fn), ctrl.indexOf('\n};', ctrl.indexOf(fn)));
    assert.match(body, /String\(doc\.ownerId\) !== String\(req\.admin\._id\)/, `${fn} must check ownership`);
    assert.match(body, /isSuperAdmin/, `${fn} must still allow a super admin`);
  }
});

test('a retired favourite is soft-deleted, never erased', () => {
  const body = ctrl.slice(ctrl.indexOf('exports.remove'), ctrl.indexOf('exports.markUsed'));
  assert.ok(!/deleteOne|findByIdAndDelete|remove\(\)/.test(body), 'deleting must not destroy the record');
  assert.match(body, /isActive = false/);
});

test('reading is open to note-readers; writing needs prescriptions.draft', () => {
  for (const line of routes.split('\n')) {
    if (!/^router\.(get|post|patch|delete)\(/.test(line.trim())) continue;
    assert.match(line, /requirePermission/, `ungated route: ${line.trim()}`);
    if (/router\.(post|patch|delete)/.test(line)) {
      assert.match(line, /prescriptions\.draft/, `write route must need prescriptions.draft: ${line.trim()}`);
    }
  }
  // Saving a favourite is not signing a prescription: the sign permission must
  // not appear here at all, or the shelf becomes a way around the gate.
  assert.ok(!routes.includes('prescriptions.sign'), 'the favourites shelf must not touch the signing gate');
});

test('"recent" is built from this doctor\'s own notes, not the clinic\'s', () => {
  const body = ctrl.slice(ctrl.indexOf('exports.recent'));
  assert.match(body, /doctorId: req\.admin\._id/, 'recent must be scoped to the signed-in dermatologist');
  // Another dermatologist's habits are not a useful suggestion, and a
  // clinic-wide list is just a top-20 of whatever the busiest doctor writes.
  assert.ok(!/ConsultationNote\.find\(\{\s*\}/.test(body), 'recent must never read every note in the clinic');
});

test('the audit trail knows about saved prescriptions', () => {
  // A favourite shapes every prescription written from it; the action has to
  // exist in the enum or the audit write fails validation and is lost.
  const audit = fs.readFileSync(path.join(ROOT, 'models', 'AdminAuditLog.js'), 'utf8');
  assert.ok(audit.includes("'RX_FAVOURITE_SAVED'"), 'AdminAuditLog is missing RX_FAVOURITE_SAVED');
  assert.ok(routes.includes("auditLog('RX_FAVOURITE_SAVED'"), 'saving a favourite must be audited');
});
