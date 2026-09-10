const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { toPreConsultDocument, toFormValues } = require('../utils/walkinPreConsult');

/**
 * The walk-in check-in at the front desk.
 *
 * Two things are pinned here.
 *
 * 1. The translation between the form's flat answers (the shape the tablet and
 *    the app both post, defined by `shared/preconsult-schema.js`) and the
 *    nested `PreConsultForm` the clinic panels read. Every mismatch in that
 *    map is a clinical answer that silently disappears — a drug allergy that
 *    reads as "none", a pregnancy that reads as "not applicable" — so it is
 *    checked field by field rather than trusted.
 *
 * 2. That the route file wires the endpoints the tablet actually calls, and
 *    that none of the writing endpoints is left unauthenticated.
 */

const filled = {
  dateOfVisit: '2026-09-10',
  name: 'Asha Rao',
  dob: '1990-04-02',
  gender: 'Female',
  email: 'asha@example.com',
  maritalStatus: 'Married',
  children: '2',
  planningPregnancy: 'no',
  lmp: '2026-08-20',
  source: 'Other',
  sourceOther: 'Hoarding near the clinic',
  referredBy: 'Dr Mehta',
  reasons: ['Skin', 'Hair'],
  concerns: ['Acne / Pimple', 'Pigmentation', 'Hair Fall / Thinning'],
  concernsOther: 'Dark circles',
  medical: ['Diabetes', 'Thyroid Disorder'],
  menstrualHistory: 'irregular',
  drugAllergies: true,
  drugAllergiesDetail: 'Penicillin',
  otherAllergies: 'Fragrance',
  cleanser: 'Cetaphil',
  moisturiser: 'Venusia',
  sunscreen: 'SPF 50',
  otherProducts: 'Vitamin C serum',
  diet: 'non-veg',
  waterIntake: '2.5',
  newProducts: 'yes',
  newProductsDetail: 'A retinol serum',
  salonVisit: 'no',
  salonVisitDetail: '',
  pastTreatments: 'yes',
  pastTreatmentsDetail: 'Chemical peel, 2024',
  symptomDuration: 'about 6 months',
  previousTreatments: 'Clindamycin gel, helped a little',
  currentMedications: 'Thyroxine 50mcg',
  pregnancyStatus: 'not_pregnant',
  patientNotes: 'Sensitive to strong fragrance',
  consent: true,
  signature: 'data:image/png;base64,AAAA',
};

const guest = { patientId: 'ZEN4K2QP', fullName: 'Asha Rao', phone: '9876543210', dateOfBirth: new Date('1990-04-02') };

test('every answer on the form reaches the record', () => {
  const doc = toPreConsultDocument(filled, { user: guest, ipAddress: '10.0.0.4' });

  assert.equal(doc.clientId, 'ZEN4K2QP');
  assert.equal(doc.name, 'Asha Rao');
  assert.equal(doc.phoneNumber, '9876543210');
  assert.equal(doc.gender, 'Female');
  assert.equal(doc.numberOfChildren, 2);
  assert.equal(doc.planningForPregnancy, false);

  // "Other" is not a useful referral source on its own — the typed text is.
  assert.equal(doc.referralSource, 'Hoarding near the clinic');
  assert.equal(doc.referredBy, 'Dr Mehta');

  assert.deepEqual(doc.reasonForVisit, { skin: true, hair: true, body: false, yoga: false, nutrition: false });
  assert.equal(doc.skinConcerns.acnePimple, true);
  assert.equal(doc.skinConcerns.pigmentation, true);
  assert.equal(doc.skinConcerns.scar, false);
  assert.equal(doc.hairConcerns.hairFallThinning, true);
  assert.equal(doc.hairConcerns.hairRemoval, false);
  assert.equal(doc.hairConcerns.others, 'Dark circles');

  assert.equal(doc.medicalHistory.diabetes, true);
  assert.equal(doc.medicalHistory.thyroid, true);
  assert.equal(doc.medicalHistory.hypertension, false);
  assert.equal(doc.medicalHistory.menstrualHistory, 'Irregular');

  assert.equal(doc.drugAllergies, 'Penicillin');
  assert.equal(doc.otherAllergies, 'Fragrance');

  assert.deepEqual(doc.dailyRoutine, {
    cleanser: 'Cetaphil', moisturiser: 'Venusia', sunscreen: 'SPF 50', otherProducts: 'Vitamin C serum',
  });
  assert.equal(doc.diet.type, 'Non-Veg');
  assert.equal(doc.diet.waterIntakeLiters, 2.5);

  assert.deepEqual(doc.additionalInfo.newSkincareProducts, { used: true, details: 'A retinol serum' });
  assert.deepEqual(doc.additionalInfo.recentSalonVisit, { visited: false, details: null });
  assert.deepEqual(doc.additionalInfo.pastTreatmentsSurgeries, { had: true, details: 'Chemical peel, 2024' });

  assert.equal(doc.symptomDuration, 'about 6 months');
  assert.equal(doc.currentMedications, 'Thyroxine 50mcg');
  assert.equal(doc.pregnancyStatus, 'not_pregnant');
  assert.equal(doc.patientNotes, 'Sensitive to strong fragrance');

  assert.equal(doc.clientSignature, filled.signature);
  assert.equal(doc.healthDataConsent.accepted, true);
  assert.equal(doc.healthDataConsent.ipAddress, '10.0.0.4');
  assert.equal(doc.status, 'Submitted');
});

test('"no drug allergies" is recorded as an answer, not as a blank', () => {
  // A blank field cannot be told apart from "nobody asked", which is exactly
  // the ambiguity a doctor must not meet before prescribing.
  const doc = toPreConsultDocument({ ...filled, drugAllergies: false, drugAllergiesDetail: '' }, { user: guest });
  assert.equal(doc.drugAllergies, 'None reported');
});

test('a "yes" with no detail still reads as an allergy', () => {
  const doc = toPreConsultDocument({ ...filled, drugAllergiesDetail: '   ' }, { user: guest });
  assert.match(doc.drugAllergies, /^Yes/);
});

test('a blank water intake is null, never NaN', () => {
  // Number('') is 0 and Number('abc') is NaN; Mongoose rejects the second and
  // the first would invent an answer nobody gave.
  assert.equal(toPreConsultDocument({ ...filled, waterIntake: '' }, { user: guest }).diet.waterIntakeLiters, null);
  assert.equal(toPreConsultDocument({ ...filled, waterIntake: 'two' }, { user: guest }).diet.waterIntakeLiters, null);
  assert.equal(toPreConsultDocument({ ...filled, children: '' }, { user: guest }).numberOfChildren, 0);
});

test('the old thyroidDisorder name stays in step with thyroid', () => {
  // Panel code written before the rename still reads the old field.
  const doc = toPreConsultDocument(filled, { user: guest });
  assert.equal(doc.medicalHistory.thyroidDisorder, doc.medicalHistory.thyroid);
});

test('last visit pre-fills the next form, but never the consent or the signature', () => {
  const doc = toPreConsultDocument(filled, { user: guest });
  const back = toFormValues(doc);

  assert.equal(back.name, 'Asha Rao');
  assert.equal(back.dob, '1990-04-02');
  assert.deepEqual(back.reasons.sort(), ['Hair', 'Skin']);
  assert.ok(back.concerns.includes('Acne / Pimple'));
  assert.ok(back.concerns.includes('Hair Fall / Thinning'));
  assert.deepEqual(back.medical.sort(), ['Diabetes', 'Thyroid Disorder']);
  assert.equal(back.drugAllergies, true);
  assert.equal(back.drugAllergiesDetail, 'Penicillin');
  assert.equal(back.diet, 'non-veg');
  assert.equal(back.waterIntake, '2.5');
  assert.equal(back.symptomDuration, 'about 6 months');

  // Both have to be given again for this visit — a signature carried forward
  // would be a signature the guest did not make today.
  assert.equal(back.consent, false);
  assert.equal(back.signature, '');
});

test('"None reported" comes back as no allergy, not as an allergy called None', () => {
  const doc = toPreConsultDocument({ ...filled, drugAllergies: false }, { user: guest });
  const back = toFormValues(doc);
  assert.equal(back.drugAllergies, false);
  assert.equal(back.drugAllergiesDetail, '');
});

test('the walk-in routes are wired, and every write is authenticated', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'walkin.js'), 'utf8');
  for (const p of ['/branches', '/send-otp', '/verify-otp', '/profile', '/me', '/preconsult', '/finish']) {
    assert.ok(src.includes(`'${p}'`), `walk-in route ${p} is missing`);
  }
  // The form and the session endpoints must sit behind a bearer session.
  for (const line of src.split('\n')) {
    if (!/router\.(post|get)\(/.test(line)) continue;
    if (/\/branches|\/send-otp|\/verify-otp/.test(line)) continue;       // public by design
    if (/\/profile/.test(line)) { assert.match(line, /optionalAuth/); continue; } // proof OR session
    assert.match(line, /protect/, `unauthenticated walk-in route: ${line.trim()}`);
  }
});

test('the walk-in never writes a patient before the number is proved', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'walkinController.js'), 'utf8');
  const verify = src.slice(src.indexOf('exports.verifyOtp'), src.indexOf('exports.saveProfile'));
  assert.ok(!/User\.create/.test(verify), 'verify-otp must not create a patient — profile does, after the details are known');
  // And the proof must be consumed before the account exists, or a double tap
  // makes two patients (and two Zenoti guests).
  const profile = src.slice(src.indexOf('exports.saveProfile'), src.indexOf('exports.me'));
  assert.ok(profile.indexOf('findOneAndUpdate') < profile.indexOf('User.create'), 'consume the OTP proof before creating the patient');
});

test('a form with no appointment is still findable — the walk-in case', () => {
  /*
   * A guest who checks in at the front desk has no booking, so their form
   * carries no bookingId. Every path the clinic uses to reach a form must
   * therefore fall back to the guest, or their answers sit unread:
   *
   *   · the reception chip on an appointment (getFormStatusForBooking)
   *   · the app's own gate (intakeStatus — already userId-only)
   *   · the admin list the panels read (getAllForms?userId=)
   *
   * The dermatologist panel's consultation card does the same fallback in its
   * own repo; this pins the server half.
   */
  const ctrl = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'preConsultFormController.js'), 'utf8');

  const byBooking = ctrl.slice(ctrl.indexOf('exports.getFormStatusForBooking'), ctrl.indexOf('POST /api/pre-consult-forms/photos'));
  assert.match(byBooking, /PreConsultForm\.findOne\(\{\s*userId: booking\.userId/,
    'the per-appointment status must fall back to the guest\'s own latest form');
  assert.match(byBooking, /linked/, 'and must say whether the form it found belongs to this appointment');

  const all = ctrl.slice(ctrl.indexOf('exports.getAllForms'), ctrl.indexOf('exports.getAdminFormById'));
  assert.match(all, /if \(userId\) query\.userId = userId;/, 'the panel lists a guest\'s forms by userId');

  const intake = fs.readFileSync(path.join(__dirname, '..', 'utils', 'preConsultIntake.js'), 'utf8');
  assert.ok(!/bookingId/.test(intake), 'the booking gate must never require a form to be tied to an appointment');
});

test('the walk-in OTP endpoints are rate limited', () => {
  // A 30-second per-phone cooldown does not stop someone cycling through
  // numbers, and every one of those is a WhatsApp message the clinic pays for.
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'walkin.js'), 'utf8');
  for (const line of src.split('\n')) {
    if (!/\/send-otp|\/verify-otp/.test(line)) continue;
    assert.match(line, /walkInOtpLimiter/, `unthrottled OTP route: ${line.trim()}`);
  }
});

test('a lean read of a pre-consult loses every encrypted answer', () => {
  /*
   * Half this record is encrypted at rest — medical history, allergies,
   * current medication, the recent-activity answers. mongoose-field-encryption
   * decrypts in a post('init') hook, and mongoose skips post('init') entirely
   * for .lean(). A lean read therefore hands back ciphertext STRINGS where the
   * mapper expects objects, and the pre-fill comes up silently missing the
   * clinical half of the form rather than failing.
   *
   * This is not hypothetical: latestFormValues was written with .lean().
   */
  process.env.ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET || 'test-secret-for-walkin-spec';
  delete require.cache[require.resolve('../models/PreConsultForm')];
  const Model = require('../models/PreConsultForm');

  const doc = new Model({
    userId: new (require('mongoose').Types.ObjectId)(),
    ...toPreConsultDocument(filled, { user: guest }),
  });

  // Sanity: readable before encryption.
  assert.equal(toFormValues(doc.toObject()).drugAllergiesDetail, 'Penicillin');

  doc.encryptFieldsSync();
  const asLeanWouldSee = toFormValues(doc.toObject());
  assert.notEqual(asLeanWouldSee.drugAllergiesDetail, 'Penicillin',
    'if this ever passes, the field stopped being encrypted — check the model');
  assert.deepEqual(asLeanWouldSee.medical, [], 'medical history is unreadable from a lean read');
  assert.equal(asLeanWouldSee.newProducts, '', 'recent activity is unreadable from a lean read');

  // And the fix: the controller must not lean-read the form it pre-fills from.
  const ctrl = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'walkinController.js'), 'utf8');
  const fn = ctrl.slice(ctrl.indexOf('async function latestFormValues'), ctrl.indexOf('// @desc    Branches'));
  assert.ok(!/\.lean\(\)/.test(fn), 'latestFormValues must not use .lean() — it reads encrypted fields');
});
