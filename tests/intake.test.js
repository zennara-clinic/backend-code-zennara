const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/**
 * The three-state pre-consult intake and the panel's paper-form editor.
 *
 * Pinned here:
 *
 *   1. utils/preConsultSchema mirrors the Walk-In Form's zod schema key for
 *      key and option for option. The tablet's file is read from disk and
 *      compared, so a question added or renamed on the tablet fails this test
 *      until the panel definition follows — the two are one form.
 *   2. validate() refuses what the tablet refuses (name, dob, gender, reasons,
 *      options, caps) and nothing the tablet accepts.
 *   3. inferOrigin tells an old walk-in row from an old app row by its
 *      signature, so no form ever shows a blank provenance.
 *   4. intakeStatus maps form / evidence / nothing to digital / paper / none
 *      while keeping the done + waived pair the booking gate reads.
 *
 * No database: the lookups are injected.
 */

const { describe, validate, emptyValues } = require('../utils/preConsultSchema');
const intake = require('../utils/preConsultIntake');

/* ------------------------------------------------------------------------ *
 * The tablet's schema, read from disk
 * ------------------------------------------------------------------------ */

const TABLET_SCHEMA = path.join(__dirname, '..', '..', 'Walk-In Form', 'shared', 'preconsult-schema.js');
const tabletSource = fs.existsSync(TABLET_SCHEMA) ? fs.readFileSync(TABLET_SCHEMA, 'utf8') : null;

/** The keys of `preConsultSchema = z.object({ ... })`, in order. */
function zodKeys(src) {
  const start = src.indexOf('export const preConsultSchema = z.object({');
  const end = src.indexOf('\n});', start);
  const body = src.slice(start, end);
  return [...body.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]);
}

/** `export const NAME = [ "a", "b" ];` → ['a', 'b'] */
function stringList(src, name) {
  const m = src.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\];`));
  assert.ok(m, `${name} not found in the tablet schema`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/** PREGNANCY_OPTIONS: `{ value: "x", label: "y" }` rows. */
function pregnancyList(src) {
  const start = src.indexOf('export const PREGNANCY_OPTIONS = [');
  const end = src.indexOf('];', start);
  return [...src.slice(start, end).matchAll(/\{\s*value:\s*"([^"]+)",\s*label:\s*"([^"]+)"\s*\}/g)].map((m) => ({ value: m[1], label: m[2] }));
}

const fieldsOf = (def) => def.steps.flatMap((s) => s.fields);
const fieldByKey = (def, key) => fieldsOf(def).find((f) => f.key === key);

test('the panel definition carries every question the tablet asks, except consent and signature', { skip: !tabletSource && 'Walk-In Form checkout not present' }, () => {
  const expected = zodKeys(tabletSource).filter((k) => k !== 'consent' && k !== 'signature');
  assert.ok(expected.length > 30, 'the zod schema should have been parsed');
  assert.ok(zodKeys(tabletSource).includes('consent') && zodKeys(tabletSource).includes('signature'));

  const def = describe();
  const keys = fieldsOf(def).map((f) => f.key);
  assert.deepEqual(new Set(keys), new Set(expected));
  assert.equal(new Set(keys).size, keys.length, 'no key is defined twice');
  assert.deepEqual(new Set(Object.keys(def.empty)), new Set(expected), 'empty values cover the same keys');
});

test('every option list matches the tablet', { skip: !tabletSource && 'Walk-In Form checkout not present' }, () => {
  const def = describe();
  const values = (key) => fieldByKey(def, key).options.map((o) => o.value);
  assert.deepEqual(values('gender'), stringList(tabletSource, 'GENDER_OPTIONS'));
  assert.deepEqual(values('maritalStatus'), stringList(tabletSource, 'STATUS_OPTIONS'));
  assert.deepEqual(values('source'), stringList(tabletSource, 'SOURCE_OPTIONS'));
  assert.deepEqual(values('reasons'), stringList(tabletSource, 'REASON_OPTIONS'));
  assert.deepEqual(values('concerns'), stringList(tabletSource, 'CONCERN_OPTIONS'));
  assert.deepEqual(values('medical'), stringList(tabletSource, 'MEDICAL_OPTIONS'));
  assert.deepEqual(fieldByKey(def, 'pregnancyStatus').options, pregnancyList(tabletSource));
  // The inline enums the zod schema spells out rather than exports.
  assert.deepEqual(values('menstrualHistory'), ['regular', 'irregular']);
  assert.deepEqual(values('diet'), ['veg', 'non-veg']);
});

test('the seven steps, in the tablet\'s order, with well-formed fields', () => {
  const def = describe();
  assert.deepEqual(def.steps.map((s) => s.key), ['personal', 'reason', 'complaint', 'medical', 'routine', 'recent', 'sign']);
  assert.deepEqual(def.steps.map((s) => s.title), ['About you', 'Reason for visit', 'Your concern', 'Medical history', 'Daily routine', 'Recent activity', 'Review & sign']);
  assert.deepEqual(def.steps[6].fields, [], 'the signing step has nothing to type — the signature is on the paper');

  const TYPES = new Set(['text', 'textarea', 'date', 'email', 'number', 'select', 'chips', 'multichips', 'yesno', 'boolean']);
  for (const f of fieldsOf(def)) {
    assert.ok(TYPES.has(f.type), `${f.key}: unknown type ${f.type}`);
    assert.equal(typeof f.label, 'string');
    assert.equal(typeof f.required, 'boolean', `${f.key}: required must be stated`);
    if (['select', 'chips', 'multichips'].includes(f.type)) {
      assert.ok(Array.isArray(f.options) && f.options.length, `${f.key}: needs options`);
      for (const o of f.options) assert.deepEqual(Object.keys(o).sort(), ['label', 'value']);
    } else {
      assert.equal(f.options, undefined, `${f.key}: only choice fields carry options`);
    }
    if (f.showIf) assert.deepEqual(Object.keys(f.showIf).sort(), ['equals', 'key']);
  }

  // The conditional questions, exactly as the tablet shows them.
  assert.deepEqual(fieldByKey(def, 'sourceOther').showIf, { key: 'source', equals: 'Other' });
  assert.deepEqual(fieldByKey(def, 'drugAllergiesDetail').showIf, { key: 'drugAllergies', equals: true });
  for (const k of ['newProductsDetail', 'salonVisitDetail', 'pastTreatmentsDetail']) {
    assert.equal(fieldByKey(def, k).showIf.equals, 'yes', k);
  }
  for (const k of ['lmp', 'menstrualHistory', 'planningPregnancy', 'pregnancyStatus']) {
    assert.deepEqual(fieldByKey(def, k).showIf, { key: 'gender', equals: 'Female' }, k);
  }
  // The zod caps.
  assert.equal(fieldByKey(def, 'symptomDuration').maxLength, 200);
  assert.equal(fieldByKey(def, 'previousTreatments').maxLength, 2000);
  assert.equal(fieldByKey(def, 'waterIntake').maxLength, 10);
  assert.equal(fieldByKey(def, 'cleanser').maxLength, 500);
});

test('describe() hands out a fresh copy every time', () => {
  const a = describe();
  a.steps[0].fields[0].label = 'changed';
  a.steps[0].fields.push({ key: 'x' });
  const b = describe();
  assert.notEqual(b.steps[0].fields[0].label, 'changed');
  assert.ok(!b.steps[0].fields.some((f) => f.key === 'x'));
});

/* ------------------------------------------------------------------------ *
 * validate()
 * ------------------------------------------------------------------------ */

const good = () => ({
  ...emptyValues(),
  name: 'Asha Rao',
  dob: '1990-04-02',
  gender: 'Female',
  reasons: ['Skin'],
  source: 'Google',
  drugAllergies: true,
  drugAllergiesDetail: 'Penicillin',
  pregnancyStatus: 'not_pregnant',
});

test('a complete paper form passes without consent or a signature', () => {
  const r = validate(good());
  assert.deepEqual(r, { ok: true, errors: {} });
});

test('the tablet\'s refusals: blank name, no reason, impossible age, unknown source', () => {
  assert.equal(validate({ ...good(), name: ' ' }).errors.name, 'Please enter your full name.');
  assert.equal(validate({ ...good(), name: 'A' }).errors.name, 'Please enter your full name.');
  assert.equal(validate({ ...good(), reasons: [] }).errors.reasons, 'Select at least one reason for your visit.');
  assert.equal(validate({ ...good(), dob: '' }).errors.dob, 'Please enter a valid date of birth.');
  assert.equal(validate({ ...good(), dob: 'not a date' }).errors.dob, 'Please enter a valid date of birth.');
  const y = new Date().getFullYear();
  assert.ok(validate({ ...good(), dob: `${y - 121}-01-01` }).errors.dob, 'a 121-year-old is refused');
  assert.ok(validate({ ...good(), dob: `${y}-01-01` }).errors.dob, 'under one year old is refused');
  // 120 years less a few months — inside the tablet's `years <= 120` window whatever today's date.
  assert.equal(validate({ ...good(), dob: `${y - 119}-12-31` }).errors.dob, undefined, 'just under 120 is allowed');
  assert.ok(validate({ ...good(), source: 'TV ad' }).errors.source, 'a source outside the options is refused');
  assert.equal(validate({ ...good(), source: '' }).errors.source, undefined, 'no source is fine');
  assert.equal(validate({ ...good(), gender: 'Unknown' }).errors.gender, 'Please select your gender.');
  assert.equal(validate({ ...good(), gender: '' }).errors.gender, 'Please select your gender.');
});

test('enum fields must be one of their options; free text stays under its cap', () => {
  assert.ok(validate({ ...good(), reasons: ['Skin', 'Dental'] }).errors.reasons);
  assert.ok(validate({ ...good(), concerns: ['Wrinkles'] }).errors.concerns);
  assert.ok(validate({ ...good(), medical: ['Asthma'] }).errors.medical);
  assert.ok(validate({ ...good(), maritalStatus: 'Divorced' }).errors.maritalStatus);
  assert.ok(validate({ ...good(), diet: 'keto' }).errors.diet);
  assert.ok(validate({ ...good(), menstrualHistory: 'sometimes' }).errors.menstrualHistory);
  assert.ok(validate({ ...good(), newProducts: 'maybe' }).errors.newProducts);
  assert.ok(validate({ ...good(), pregnancyStatus: 'yes' }).errors.pregnancyStatus);
  assert.ok(validate({ ...good(), drugAllergies: 'yes' }).errors.drugAllergies, 'drug allergies is a boolean');
  assert.ok(validate({ ...good(), email: 'not-an-email' }).errors.email);
  assert.equal(validate({ ...good(), email: '' }).errors.email, undefined);

  assert.ok(validate({ ...good(), symptomDuration: 'x'.repeat(201) }).errors.symptomDuration);
  assert.equal(validate({ ...good(), symptomDuration: 'x'.repeat(200) }).errors.symptomDuration, undefined);
  assert.ok(validate({ ...good(), previousTreatments: 'x'.repeat(2001) }).errors.previousTreatments);
  assert.ok(validate({ ...good(), cleanser: 'x'.repeat(501) }).errors.cleanser);
  assert.ok(validate({ ...good(), waterIntake: '2 to 3 litres' }).errors.waterIntake);
  assert.ok(validate({ ...good(), children: '1000' }).errors.children);
  assert.equal(validate({ ...good(), children: 2 }).errors.children, undefined, 'a numeric answer is fine');
  assert.equal(validate(null).ok, false, 'nothing at all is not a form');
});

/* ------------------------------------------------------------------------ *
 * inferOrigin
 * ------------------------------------------------------------------------ */

test('an old row is walk-in by its PNG signature, app otherwise — and says it was inferred', () => {
  const PreConsultForm = require('../models/PreConsultForm');
  const created = new Date('2025-03-03T10:00:00Z');

  const walkin = PreConsultForm.inferOrigin({ clientSignature: 'data:image/png;base64,AAAA', createdAt: created });
  assert.equal(walkin.channel, 'walkin');
  assert.equal(walkin.capturedOn, 'digital');
  assert.equal(walkin.inferred, true);
  assert.equal(walkin.enteredAt, created);
  assert.equal(walkin.signatureOnPaper, false);

  const app = PreConsultForm.inferOrigin({ clientSignature: 'Asha Rao|cursive', createdAt: created });
  assert.equal(app.channel, 'app');
  assert.equal(app.inferred, true);
  assert.equal(PreConsultForm.inferOrigin({ clientSignature: null }).channel, 'app');
  assert.equal(PreConsultForm.inferOrigin({ origin: { channel: null } }).channel, 'app', 'an empty origin sub-document still infers');
  assert.equal(PreConsultForm.inferOrigin(null), null);
});

test('a stored origin is returned as recorded, not inferred', () => {
  const PreConsultForm = require('../models/PreConsultForm');
  const paper = new Date('2024-03-03T00:00:00Z');
  const o = PreConsultForm.inferOrigin({
    clientSignature: null,
    origin: { channel: 'staff', capturedOn: 'paper', paperDate: paper, enteredBy: { id: 'a1', name: 'Priya', role: 'staff' }, enteredAt: paper, signatureOnPaper: true },
  });
  assert.equal(o.channel, 'staff');
  assert.equal(o.capturedOn, 'paper');
  assert.equal(o.paperDate, paper);
  assert.deepEqual(o.enteredBy, { id: 'a1', name: 'Priya', role: 'staff' });
  assert.equal(o.signatureOnPaper, true);
  assert.equal(o.inferred, false);
});

/* ------------------------------------------------------------------------ *
 * intakeStatus — the three states, with stubbed lookups
 * ------------------------------------------------------------------------ */

const NONE = { completedVisits: 0, packages: 0, prescriptions: 0 };
const lookups = ({ form = null, evidence = NONE, evidenceThrows = false } = {}) => ({
  latestSubmitted: async () => form,
  evidence: async () => { if (evidenceThrows) throw new Error('db down'); return evidence; },
});

test('a submitted form → digital: done, not waived, with its origin and without its signature', async () => {
  const form = { _id: 'f1', status: 'Submitted', updatedAt: new Date(), createdAt: new Date(), clientSignature: 'data:image/png;base64,AAAA' };
  const s = await intake.intakeStatus('u1', lookups({ form, evidence: { completedVisits: 3, packages: 0, prescriptions: 1 } }));
  assert.equal(s.state, 'digital');
  assert.equal(s.done, true);
  assert.equal(s.waived, false);
  assert.equal(s.reason, null);
  assert.equal(s.form._id, 'f1');
  assert.equal(s.form.clientSignature, undefined, 'the signature never travels with the status');
  assert.equal(s.origin.channel, 'walkin');
  assert.deepEqual(s.evidence, { completedVisits: 3, packages: 0, prescriptions: 1 });
  assert.equal(intake.labelFor(s.state), 'Digital');
});

test('no form but clinic evidence → paper: done AND waived, with the reason the app shows', async () => {
  const visited = await intake.intakeStatus('u2', lookups({ evidence: { completedVisits: 2, packages: 0, prescriptions: 0 } }));
  assert.equal(visited.state, 'paper');
  assert.equal(visited.done, true);
  assert.equal(visited.waived, true);
  assert.match(visited.reason, /an earlier visit/);
  assert.equal(visited.form, null);
  assert.equal(visited.origin, null);
  assert.equal(intake.labelFor(visited.state), 'On paper');

  const packaged = await intake.intakeStatus('u3', lookups({ evidence: { completedVisits: 0, packages: 1, prescriptions: 0 } }));
  assert.equal(packaged.state, 'paper');
  assert.match(packaged.reason, /a package bought at the clinic/);

  const prescribed = await intake.intakeStatus('u4', lookups({ evidence: { completedVisits: 0, packages: 0, prescriptions: 1 } }));
  assert.equal(prescribed.state, 'paper');
  assert.match(prescribed.reason, /a clinic prescription/);
});

test('nothing on file → none: not done, not waived', async () => {
  const s = await intake.intakeStatus('u5', lookups());
  assert.deepEqual(s, { state: 'none', done: false, waived: false, reason: null, form: null, origin: null, evidence: NONE });
  assert.equal(intake.labelFor(s.state), 'Not yet');
  assert.equal(intake.labelFor('garbage'), 'Not yet');
});

test('a failed evidence lookup never throws out of the gate — it reads as no evidence', async () => {
  const s = await intake.intakeStatus('u6', lookups({ evidenceThrows: true }));
  assert.equal(s.state, 'none');
  assert.equal(s.done, false);
});

test('stateOf and intakeRow: the pure mapping and the list-row shape', () => {
  assert.equal(intake.stateOf({ form: { _id: 'f' }, evidence: NONE }), 'digital');
  assert.equal(intake.stateOf({ form: null, evidence: { ...NONE, packages: 1 } }), 'paper');
  assert.equal(intake.stateOf({}), 'none');

  const at = new Date();
  assert.deepEqual(
    intake.intakeRow({ state: 'digital', formId: 'f', origin: { channel: 'staff', capturedOn: 'paper' }, lastVisitAt: at }),
    { state: 'digital', label: 'Digital', formId: 'f', capturedOn: 'paper', channel: 'staff', lastVisitAt: at },
  );
  assert.deepEqual(intake.intakeRow(undefined), { state: 'none', label: 'Not yet', formId: null, capturedOn: null, channel: null, lastVisitAt: null });
});

/* ------------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------------ */

test('the intake routes are declared before /admin/:id, and digitising is permission- and guest-scoped', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'preConsultForm.js'), 'utf8');
  const at = (s) => { const i = src.indexOf(s); assert.ok(i >= 0, `${s} missing`); return i; };
  const generic = at("router.get('/admin/:id'");
  assert.ok(at("'/admin/schema'") < generic, 'schema would be matched as an id');
  assert.ok(at("'/admin/intake/:userId'") < generic, 'intake would be matched as an id');
  assert.ok(at("'/admin/digitise/:userId'") < generic, 'digitise would be matched as an id');

  const digitise = src.slice(at("'/admin/digitise/:userId'"), src.indexOf('digitiseForUser,', at("'/admin/digitise/:userId'")));
  assert.match(digitise, /requirePermission\('patients\.manage', 'forms\.view'\)/);
  assert.match(digitise, /scope\.ownGuest\(\(req\) => req\.params\.userId\)/);
});

test('every path that creates a form stamps its channel', () => {
  const walkin = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'walkinController.js'), 'utf8');
  assert.match(walkin, /origin: \{ channel: 'walkin', capturedOn: 'digital'/);
  const ctrl = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'preConsultFormController.js'), 'utf8');
  assert.match(ctrl, /channel: 'app', capturedOn: 'digital'/);
  assert.match(ctrl, /channel: 'staff',\s*\n\s*capturedOn: 'paper'/);
  // The app can never post its own provenance.
  assert.match(ctrl, /delete formData\.origin/);
});
