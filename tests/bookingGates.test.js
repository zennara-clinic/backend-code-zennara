const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { decide } = require('../utils/guestEligibility');

/**
 * The clinic's two booking gates:
 *
 *   1. No pre-consultation intake  → no dermatologist consultation.
 *   2. No completed consultation   → no treatment.
 *
 * Both were wrong at some point in a way no test could see, so they are pinned
 * here: the intake gate lived only in the app (a deep link walked straight past
 * it), and the treatment gate read `!isNewGuest`, which any past treatment
 * satisfied — so a guest could book treatment after treatment without a
 * dermatologist ever seeing them.
 */

test('a guest who has never been must see a dermatologist first', () => {
  const d = decide({});
  assert.equal(d.isNewGuest, true);
  assert.equal(d.hasBeenAssessed, false, 'a new guest may not book a treatment');
  assert.match(d.message, /first visit/i);
});

test('past TREATMENTS alone never unlock more treatments', () => {
  // The bug this file exists for: three completed visits, no consultation.
  const d = decide({ completedVisits: 3, completedConsultations: 0 });
  assert.equal(d.isNewGuest, false, 'they are not new — the clinic knows them');
  assert.equal(d.hasBeenAssessed, false, 'but no dermatologist has assessed them');
  assert.match(d.message, /needs to see you/i);
  // And they must not be told they are a first-time guest.
  assert.doesNotMatch(d.message, /first visit/i);
});

test('a completed consultation unlocks treatments', () => {
  const d = decide({ completedVisits: 1, completedConsultations: 1 });
  assert.equal(d.hasCompletedConsultation, true);
  assert.equal(d.hasBeenAssessed, true);
  assert.equal(d.message, null);
});

test('a doctor\'s note counts as having been seen, whatever the booking said', () => {
  // Zenoti visits are often filed as the treatment, not the consultation.
  const d = decide({ completedVisits: 0, completedConsultations: 0, prescriptions: 1 });
  assert.equal(d.hasBeenAssessed, true);
});

test('owning a package keeps it redeemable', () => {
  // The desk sold it after assessing them; blocking redemption would take away
  // something already paid for.
  const d = decide({ ownedPackages: 1 });
  assert.equal(d.hasBeenAssessed, true);
  assert.equal(d.message, null);
});

test('the treatment gate is not "any past visit"', () => {
  const src = fs.readFileSync(path.join(__dirname, '../utils/guestEligibility.js'), 'utf8');
  // Comments deliberately quote the old rule to explain why it was wrong, so
  // strip them before asserting on what the code actually does.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/canBookTreatment:\s*!isNewGuest/.test(code),
    'canBookTreatment must depend on having been assessed, not merely on not being new');
  assert.ok(/canBookTreatment:\s*hasBeenAssessed/.test(code));
});

test('the consultation gate is enforced on the server, not only in the app', () => {
  const src = fs.readFileSync(path.join(__dirname, '../utils/guestEligibility.js'), 'utf8');
  assert.ok(/PRE_CONSULT_REQUIRED/.test(src),
    'booking a consultation must be refused server-side when the intake is missing');
  // The app's redirect is a convenience; a deep link must not walk past it.
  assert.ok(/intakeStatus/.test(src));
});

test('the intake rule lives in one place, so the API and the app cannot disagree', () => {
  const shared = path.join(__dirname, '../utils/preConsultIntake.js');
  assert.ok(fs.existsSync(shared), 'utils/preConsultIntake.js must own the rule');
  const ctrl = fs.readFileSync(path.join(__dirname, '../controllers/preConsultFormController.js'), 'utf8');
  assert.ok(/require\('\.\.\/utils\/preConsultIntake'\)/.test(ctrl),
    'the status endpoint must use the shared rule, not its own copy');
  const gate = fs.readFileSync(path.join(__dirname, '../utils/guestEligibility.js'), 'utf8');
  assert.ok(/require\('\.\/preConsultIntake'\)/.test(gate));
});

test('an existing clinic guest is never blocked behind a form they signed on paper', () => {
  const src = fs.readFileSync(path.join(__dirname, '../utils/preConsultIntake.js'), 'utf8');
  assert.ok(/waived: true/.test(src), 'clinic history waives the app intake');
  // …but it must be reported as waived, not as a submission the clinic never got.
  assert.ok(/done:\s*true,\s*\n\s*waived:\s*true/.test(src), 'the waiver must report done AND waived together');
});
