/**
 * The pre-consult form as a field list, for the panel that types a paper
 * sheet up on a guest's behalf.
 *
 * This is the Walk-In Form's `shared/preconsult-schema.js` (keys, options,
 * limits) and `src/components/PreConsultForm.jsx` (steps, labels, hints, which
 * question shows when) written out as data, so the admin and dermatologist
 * panels can render the same seven steps without importing a React component
 * or the zod dependency. tests/intake.test.js reads the tablet's schema file
 * and asserts every key and option list here matches it — change a question
 * there and this file fails its test until it follows.
 *
 * Two things are deliberately NOT here: `consent` and `signature`. A paper
 * form carries the guest's wet signature and their declaration on the sheet
 * itself; the digitising endpoint records that (origin.signatureOnPaper) and
 * never asks the staff member to sign for the guest.
 */

const { clinicDateKey } = require('./bookingTime');

/* ---- Options: MUST match "Walk-In Form/shared/preconsult-schema.js" ---- */

const GENDER_OPTIONS = ['Female', 'Male', 'Other'];
const STATUS_OPTIONS = ['Single', 'Married', 'Other'];
const SOURCE_OPTIONS = ['Instagram', 'Facebook', 'Google', 'Friend / Family', 'Doctor referral', 'Walk-in', 'Other'];
const REASON_OPTIONS = ['Skin', 'Hair', 'Body', 'Yoga', 'Nutrition'];
const CONCERN_OPTIONS = [
  'Acne / Pimple',
  'Scar',
  'Pigmentation',
  'Skin Sagging',
  'Skin Tightening',
  'Wart / Skin Tag',
  'Hair Fall / Thinning',
  'Hair Removal',
];
const MEDICAL_OPTIONS = ['Hypertension', 'Diabetes', 'Thyroid Disorder'];
const PREGNANCY_OPTIONS = [
  { value: 'not_applicable', label: 'Not applicable' },
  { value: 'not_pregnant', label: 'Not pregnant' },
  { value: 'pregnant', label: 'Pregnant' },
  { value: 'breastfeeding', label: 'Breastfeeding' },
  { value: 'planning', label: 'Planning a pregnancy' },
  { value: 'prefer_not_to_say', label: 'Prefer not to say' },
];

const YES_NO = ['yes', 'no', ''];
const MENSTRUAL = ['regular', 'irregular', ''];
const DIET = ['veg', 'non-veg', ''];

/** The zod caps, by key: `str` is 500, the complaint fields 200/2000, waterIntake 10. */
const MAX = {
  name: 100,
  children: 3,
  sourceOther: 500,
  referredBy: 500,
  concernsOther: 500,
  drugAllergiesDetail: 500,
  otherAllergies: 500,
  cleanser: 500,
  moisturiser: 500,
  sunscreen: 500,
  otherProducts: 500,
  waterIntake: 10,
  newProductsDetail: 500,
  salonVisitDetail: 500,
  pastTreatmentsDetail: 500,
  symptomDuration: 200,
  previousTreatments: 2000,
  currentMedications: 2000,
  patientNotes: 2000,
};

const opts = (values) => values.map((v) => ({ value: v, label: v }));
const FEMALE = { key: 'gender', equals: 'Female' };

/**
 * Steps and fields, in the tablet's order with the tablet's wording.
 *
 * `type` tells the panel which control to draw:
 *   text | textarea | date | email | number   free entry
 *   select | chips                             one of `options`
 *   multichips                                 any of `options` (an array)
 *   yesno                                      'yes' | 'no' | ''
 *   boolean                                    true | false
 *
 * `showIf` is the tablet's own conditional rendering: the "Other" text box
 * under the referral source, each "please specify" under a yes/no, the drug
 * list under "any drug allergies", and the four questions the tablet only
 * asks a female guest.
 */
const STEPS = [
  {
    key: 'personal',
    title: 'About you',
    fields: [
      { key: 'dateOfVisit', label: 'Date of visit', type: 'date', required: false, hint: 'When digitising a paper sheet this is set from the paper date.' },
      { key: 'name', label: 'Full name', type: 'text', required: true, maxLength: MAX.name, hint: 'As on their ID.' },
      { key: 'dob', label: 'Date of birth', type: 'date', required: true },
      { key: 'gender', label: 'Gender', type: 'chips', required: true, options: opts(GENDER_OPTIONS) },
      { key: 'email', label: 'E-mail', type: 'email', required: false },
      { key: 'maritalStatus', label: 'Status', type: 'select', required: false, options: opts(STATUS_OPTIONS) },
      { key: 'children', label: 'No. of children', type: 'number', required: false, maxLength: MAX.children },
      { key: 'planningPregnancy', label: 'Planning for pregnancy?', type: 'yesno', required: false, showIf: FEMALE },
      { key: 'lmp', label: 'LMP (last menstrual period)', type: 'date', required: false, hint: 'Leave blank if not applicable.', showIf: FEMALE },
      { key: 'source', label: 'How did you hear about Zennara?', type: 'chips', required: false, options: opts(SOURCE_OPTIONS) },
      { key: 'sourceOther', label: 'Please specify', type: 'text', required: false, maxLength: MAX.sourceOther, showIf: { key: 'source', equals: 'Other' } },
      { key: 'referredBy', label: 'Referred by', type: 'text', required: false, maxLength: MAX.referredBy, hint: 'Name of the person or doctor who referred them, if any.' },
    ],
  },
  {
    key: 'reason',
    title: 'Reason for visit',
    fields: [
      { key: 'reasons', label: "I'm here for", type: 'multichips', required: true, options: opts(REASON_OPTIONS), hint: 'Choose all that apply.' },
      { key: 'concerns', label: 'My concerns', type: 'multichips', required: false, options: opts(CONCERN_OPTIONS), hint: 'Choose all that apply.' },
      { key: 'concernsOther', label: 'Others – please specify', type: 'textarea', required: false, maxLength: MAX.concernsOther },
    ],
  },
  {
    key: 'complaint',
    title: 'Your concern',
    fields: [
      { key: 'symptomDuration', label: 'How long has this been going on?', type: 'text', required: false, maxLength: MAX.symptomDuration },
      { key: 'previousTreatments', label: 'What have you already tried?', type: 'textarea', required: false, maxLength: MAX.previousTreatments, hint: 'Creams, tablets, treatments elsewhere — and whether they helped.' },
      { key: 'currentMedications', label: 'What are you taking right now?', type: 'textarea', required: false, maxLength: MAX.currentMedications, hint: 'All medicines and supplements, not only for skin or hair.' },
      { key: 'pregnancyStatus', label: 'Are you pregnant or breastfeeding?', type: 'chips', required: false, options: PREGNANCY_OPTIONS.map((o) => ({ ...o })), hint: 'Several treatments cannot be given during pregnancy, so the doctor needs to know.', showIf: FEMALE },
      { key: 'patientNotes', label: 'Anything else your doctor should know?', type: 'textarea', required: false, maxLength: MAX.patientNotes },
    ],
  },
  {
    key: 'medical',
    title: 'Medical history',
    fields: [
      { key: 'medical', label: 'Do you have any of these?', type: 'multichips', required: false, options: opts(MEDICAL_OPTIONS), hint: 'Leave blank if none.' },
      { key: 'menstrualHistory', label: 'Menstrual history', type: 'chips', required: false, options: [{ value: 'regular', label: 'Regular' }, { value: 'irregular', label: 'Irregular' }], showIf: FEMALE },
      { key: 'drugAllergies', label: 'Any drug allergies?', type: 'boolean', required: true },
      { key: 'drugAllergiesDetail', label: 'Which drugs?', type: 'text', required: false, maxLength: MAX.drugAllergiesDetail, showIf: { key: 'drugAllergies', equals: true } },
      { key: 'otherAllergies', label: 'Other allergies', type: 'text', required: false, maxLength: MAX.otherAllergies, hint: 'Food, cosmetics, fragrance, latex…' },
    ],
  },
  {
    key: 'routine',
    title: 'Daily routine',
    fields: [
      { key: 'cleanser', label: 'Cleanser', type: 'text', required: false, maxLength: MAX.cleanser, hint: 'Brand / product' },
      { key: 'moisturiser', label: 'Moisturiser', type: 'text', required: false, maxLength: MAX.moisturiser, hint: 'Brand / product' },
      { key: 'sunscreen', label: 'Sun screen', type: 'text', required: false, maxLength: MAX.sunscreen, hint: 'Brand / SPF' },
      { key: 'otherProducts', label: 'Other products', type: 'text', required: false, maxLength: MAX.otherProducts, hint: 'Serums, actives, supplements…' },
      { key: 'diet', label: 'Diet', type: 'chips', required: false, options: [{ value: 'veg', label: 'Veg' }, { value: 'non-veg', label: 'Non-Veg' }] },
      { key: 'waterIntake', label: 'Water intake (litres / day)', type: 'text', required: false, maxLength: MAX.waterIntake, hint: 'A number, e.g. 2.5' },
    ],
  },
  {
    key: 'recent',
    title: 'Recent activity',
    fields: [
      { key: 'newProducts', label: 'Did you start any new skin care products in the past week?', type: 'yesno', required: false },
      { key: 'newProductsDetail', label: 'If yes, please specify', type: 'text', required: false, maxLength: MAX.newProductsDetail, showIf: { key: 'newProducts', equals: 'yes' } },
      { key: 'salonVisit', label: 'Any recent salon visit in the past week?', type: 'yesno', required: false },
      { key: 'salonVisitDetail', label: 'What was done?', type: 'text', required: false, maxLength: MAX.salonVisitDetail, showIf: { key: 'salonVisit', equals: 'yes' } },
      { key: 'pastTreatments', label: 'Any past treatments or surgeries?', type: 'yesno', required: false },
      { key: 'pastTreatmentsDetail', label: 'Please specify (what & when)', type: 'text', required: false, maxLength: MAX.pastTreatmentsDetail, showIf: { key: 'pastTreatments', equals: 'yes' } },
    ],
  },
  {
    key: 'sign',
    title: 'Review & sign',
    hint: 'A paper form carries the guest\'s declaration and signature on the sheet. Record the date written on it; nobody signs on the guest\'s behalf.',
    fields: [],
  },
];

/** The tablet's emptyPreConsult(), less consent and signature. */
function emptyValues() {
  return {
    dateOfVisit: clinicDateKey(new Date()),
    name: '',
    dob: '',
    gender: '',
    email: '',
    maritalStatus: '',
    children: '',
    planningPregnancy: '',
    lmp: '',
    source: '',
    sourceOther: '',
    referredBy: '',
    reasons: [],
    concerns: [],
    concernsOther: '',
    medical: [],
    menstrualHistory: '',
    drugAllergies: false,
    drugAllergiesDetail: '',
    otherAllergies: '',
    cleanser: '',
    moisturiser: '',
    sunscreen: '',
    otherProducts: '',
    diet: '',
    waterIntake: '',
    newProducts: '',
    newProductsDetail: '',
    salonVisit: '',
    salonVisitDetail: '',
    pastTreatments: '',
    pastTreatmentsDetail: '',
    symptomDuration: '',
    previousTreatments: '',
    currentMedications: '',
    pregnancyStatus: 'not_applicable',
    patientNotes: '',
  };
}

/** @returns {{ steps: object[], empty: object }} a fresh copy each time — callers mutate it. */
function describe() {
  return {
    steps: STEPS.map((s) => ({ ...s, fields: s.fields.map((f) => ({ ...f, ...(f.options ? { options: f.options.map((o) => ({ ...o })) } : {}) })) })),
    empty: emptyValues(),
  };
}

/* ---- Validation: the zod rules, without zod ---- */

const isBlank = (v) => v === undefined || v === null || v === '';
const text = (v) => (isBlank(v) ? '' : String(v));
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Age in years for a date string, or null when it is not a date. */
function yearsSince(value) {
  const t = new Date(value);
  if (Number.isNaN(t.getTime())) return null;
  return (Date.now() - t.getTime()) / (365.25 * 86400 * 1000);
}

/**
 * The same refusals the tablet makes, keyed by field, so the panel can put
 * each message against its box. Everything not mentioned is optional and
 * only has to be the right SHAPE (a string under its cap, one of its options).
 *
 * @returns {{ ok: boolean, errors: Object<string,string> }}
 */
function validate(values) {
  const v = values && typeof values === 'object' ? values : {};
  const errors = {};

  if (text(v.name).trim().length < 2) errors.name = 'Please enter your full name.';
  else if (text(v.name).trim().length > MAX.name) errors.name = `Please keep the name under ${MAX.name} characters.`;

  const age = isBlank(v.dob) ? null : yearsSince(v.dob);
  if (age === null || age < 1 || age > 120) errors.dob = 'Please enter a valid date of birth.';

  if (!GENDER_OPTIONS.includes(v.gender)) errors.gender = 'Please select your gender.';

  if (!isBlank(v.email) && !EMAIL_RX.test(text(v.email).trim())) errors.email = 'Enter a valid e-mail address.';

  if (!isBlank(v.dateOfVisit) && Number.isNaN(new Date(v.dateOfVisit).getTime())) errors.dateOfVisit = 'Enter the date of the visit as a real date.';

  // One-of fields: blank is allowed, anything else must be an option.
  const oneOf = (key, options, message) => {
    if (isBlank(v[key])) return;
    if (!options.includes(v[key])) errors[key] = message || 'That is not one of the accepted choices.';
  };
  oneOf('maritalStatus', STATUS_OPTIONS);
  oneOf('source', SOURCE_OPTIONS, 'Choose one of the listed sources, or "Other".');
  oneOf('planningPregnancy', YES_NO);
  oneOf('newProducts', YES_NO);
  oneOf('salonVisit', YES_NO);
  oneOf('pastTreatments', YES_NO);
  oneOf('menstrualHistory', MENSTRUAL);
  oneOf('diet', DIET);
  oneOf('pregnancyStatus', PREGNANCY_OPTIONS.map((o) => o.value));

  // Any-of fields: must be an array of options; reasons needs at least one.
  const anyOf = (key, options) => {
    if (v[key] === undefined) return [];
    if (!Array.isArray(v[key])) { errors[key] = 'That is not one of the accepted choices.'; return null; }
    const bad = v[key].find((x) => !options.includes(x));
    if (bad !== undefined) { errors[key] = 'That is not one of the accepted choices.'; return null; }
    return v[key];
  };
  const reasons = anyOf('reasons', REASON_OPTIONS);
  if (reasons && reasons.length === 0) errors.reasons = 'Select at least one reason for your visit.';
  anyOf('concerns', CONCERN_OPTIONS);
  anyOf('medical', MEDICAL_OPTIONS);

  if (v.drugAllergies !== undefined && typeof v.drugAllergies !== 'boolean') errors.drugAllergies = 'Answer yes or no.';

  // Free text under the tablet's caps. `name` is checked above with its own message.
  for (const [key, max] of Object.entries(MAX)) {
    if (key === 'name' || isBlank(v[key])) continue;
    if (typeof v[key] !== 'string' && typeof v[key] !== 'number') { errors[key] = 'This answer could not be read.'; continue; }
    if (String(v[key]).trim().length > max) errors[key] = `This answer is too long — please keep it under ${max} characters.`;
  }

  return { ok: Object.keys(errors).length === 0, errors };
}

module.exports = {
  describe,
  validate,
  emptyValues,
  STEPS,
  MAX,
  GENDER_OPTIONS,
  STATUS_OPTIONS,
  SOURCE_OPTIONS,
  REASON_OPTIONS,
  CONCERN_OPTIONS,
  MEDICAL_OPTIONS,
  PREGNANCY_OPTIONS,
};
