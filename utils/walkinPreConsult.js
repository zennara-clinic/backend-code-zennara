/**
 * Translate the walk-in / app pre-consult answers (the flat shape defined by
 * `shared/preconsult-schema.js`, which mirrors the paper form field for field)
 * into the nested `PreConsultForm` document the clinic panels read.
 *
 * The flat shape exists because that is how the form is filled and how the
 * paper sheet is laid out; the nested shape exists because that is how the
 * dermatologist panel and the Zenoti note builder already read a form. Keeping
 * one translation here means neither side has to know about the other.
 */

const { guestCodeOf } = require('./guestCode');

const SKIN_CONCERNS = {
  'Acne / Pimple': 'acnePimple',
  Scar: 'scar',
  Pigmentation: 'pigmentation',
  'Skin Sagging': 'skinSagging',
  'Skin Tightening': 'skinTightening',
  'Wart / Skin Tag': 'wartSkinTag',
};

const HAIR_CONCERNS = {
  'Hair Fall / Thinning': 'hairFallThinning',
  'Hair Removal': 'hairRemoval',
};

const MEDICAL = {
  Hypertension: 'hypertension',
  Diabetes: 'diabetes',
  'Thyroid Disorder': 'thyroid',
};

const yes = (v) => v === 'yes' || v === true;

/** A number, or null — never NaN, which Mongoose would reject on a Number path. */
function num(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Drug allergies are a boolean plus free text on the form but a single string
 * on the record, because that is what the panel and prescriptions read. "No"
 * is stored explicitly: a blank field cannot be told apart from "nobody asked".
 */
function drugAllergyText(values) {
  if (!yes(values.drugAllergies)) return 'None reported';
  return String(values.drugAllergiesDetail || '').trim() || 'Yes — not specified';
}

function toPreConsultDocument(values, { user, ipAddress, bookingId } = {}) {
  const reasons = new Set(values.reasons || []);
  const concerns = new Set(values.concerns || []);
  const medical = new Set(values.medical || []);

  const skinConcerns = {};
  for (const [label, key] of Object.entries(SKIN_CONCERNS)) skinConcerns[key] = concerns.has(label);

  const medicalHistory = {};
  for (const [label, key] of Object.entries(MEDICAL)) medicalHistory[key] = medical.has(label);
  // `thyroidDisorder` is the older name for the same answer, still read by
  // panel code written before the rename. Keep both in step.
  medicalHistory.thyroidDisorder = medicalHistory.thyroid;
  medicalHistory.menstrualHistory =
    values.menstrualHistory === 'regular' ? 'Regular'
      : values.menstrualHistory === 'irregular' ? 'Irregular'
        : 'N/A';

  const referralSource = values.source === 'Other'
    ? (String(values.sourceOther || '').trim() || 'Other')
    : (values.source || null);

  return {
    ...(bookingId ? { bookingId } : {}),
    clientId: guestCodeOf(user),
    name: values.name || user?.fullName || null,
    dateOfBirth: values.dob ? new Date(values.dob) : (user?.dateOfBirth || null),
    gender: values.gender || user?.gender || 'Other',
    phoneNumber: user?.phone || null,
    email: values.email || null,
    maritalStatus: values.maritalStatus || 'Single',
    numberOfChildren: num(values.children) ?? 0,
    planningForPregnancy: yes(values.planningPregnancy),
    lastMenstrualPeriod: values.lmp || null,

    referralSource,
    referredBy: values.referredBy || null,

    reasonForVisit: {
      skin: reasons.has('Skin'),
      hair: reasons.has('Hair'),
      body: reasons.has('Body'),
      yoga: reasons.has('Yoga'),
      nutrition: reasons.has('Nutrition'),
    },
    skinConcerns,
    hairConcerns: {
      hairFallThinning: concerns.has('Hair Fall / Thinning'),
      hairRemoval: concerns.has('Hair Removal'),
      others: values.concernsOther || null,
    },
    medicalHistory,

    // Presenting complaint. Optional on the form; stored as null rather than
    // an empty string so "not answered" stays distinguishable from "nothing".
    symptomDuration: values.symptomDuration || null,
    previousTreatments: values.previousTreatments || null,
    currentMedications: values.currentMedications || null,
    pregnancyStatus: values.pregnancyStatus || 'not_applicable',
    patientNotes: values.patientNotes || null,

    drugAllergies: drugAllergyText(values),
    otherAllergies: values.otherAllergies || null,

    dailyRoutine: {
      cleanser: values.cleanser || null,
      moisturiser: values.moisturiser || null,
      sunscreen: values.sunscreen || null,
      otherProducts: values.otherProducts || null,
    },
    diet: {
      type: values.diet === 'non-veg' ? 'Non-Veg' : values.diet === 'veg' ? 'Veg' : 'Veg',
      waterIntakeLiters: num(values.waterIntake),
    },
    additionalInfo: {
      newSkincareProducts: { used: yes(values.newProducts), details: values.newProductsDetail || null },
      recentSalonVisit: { visited: yes(values.salonVisit), details: values.salonVisitDetail || null },
      pastTreatmentsSurgeries: { had: yes(values.pastTreatments), details: values.pastTreatmentsDetail || null },
    },

    clientSignature: values.signature || null,
    healthDataConsent: {
      accepted: values.consent === true,
      acceptedAt: values.consent === true ? new Date() : null,
      ipAddress: ipAddress || null,
    },
    status: 'Submitted',
    dateOfVisit: values.dateOfVisit ? new Date(values.dateOfVisit) : new Date(),
  };
}

/**
 * The reverse trip: a stored record back into form values, so a returning
 * guest's next form opens pre-filled with what they said last time and they
 * only correct what changed. Never carries the signature or the consent tick
 * across — both must be given again for this visit.
 */
function toFormValues(doc) {
  if (!doc) return null;
  /*
   * The clinic's day, not UTC's. A form saved at 11pm IST carries a UTC
   * instant on the previous date, so reading the UTC day back would pre-fill
   * the next visit with a date of visit one day before the desk recorded it.
   */
  const { clinicDateKey } = require('./bookingTime');
  const iso = (d) => (d ? clinicDateKey(new Date(d)) : '');
  const concerns = [];
  for (const [label, key] of Object.entries(SKIN_CONCERNS)) if (doc.skinConcerns?.[key]) concerns.push(label);
  for (const [label, key] of Object.entries(HAIR_CONCERNS)) if (doc.hairConcerns?.[key]) concerns.push(label);
  const medical = [];
  for (const [label, key] of Object.entries(MEDICAL)) if (doc.medicalHistory?.[key]) medical.push(label);

  const reasons = [];
  for (const [label, key] of [['Skin', 'skin'], ['Hair', 'hair'], ['Body', 'body'], ['Yoga', 'yoga'], ['Nutrition', 'nutrition']]) {
    if (doc.reasonForVisit?.[key]) reasons.push(label);
  }

  const hadDrugAllergy = Boolean(doc.drugAllergies) && !/^none/i.test(String(doc.drugAllergies));

  return {
    dateOfVisit: iso(doc.dateOfVisit),
    name: doc.name || '',
    dob: iso(doc.dateOfBirth),
    gender: doc.gender || '',
    email: doc.email || '',
    maritalStatus: doc.maritalStatus || '',
    children: doc.numberOfChildren ? String(doc.numberOfChildren) : '',
    planningPregnancy: doc.planningForPregnancy ? 'yes' : '',
    lmp: doc.lastMenstrualPeriod || '',
    source: doc.referralSource || '',
    sourceOther: '',
    referredBy: doc.referredBy || '',
    reasons,
    concerns,
    concernsOther: doc.hairConcerns?.others || '',
    medical,
    menstrualHistory: (doc.medicalHistory?.menstrualHistory || '').toLowerCase() === 'regular' ? 'regular'
      : (doc.medicalHistory?.menstrualHistory || '').toLowerCase() === 'irregular' ? 'irregular' : '',
    drugAllergies: hadDrugAllergy,
    drugAllergiesDetail: hadDrugAllergy ? doc.drugAllergies : '',
    otherAllergies: doc.otherAllergies || '',
    cleanser: doc.dailyRoutine?.cleanser || '',
    moisturiser: doc.dailyRoutine?.moisturiser || '',
    sunscreen: doc.dailyRoutine?.sunscreen || '',
    otherProducts: doc.dailyRoutine?.otherProducts || '',
    diet: doc.diet?.type === 'Non-Veg' ? 'non-veg' : doc.diet?.type === 'Veg' ? 'veg' : '',
    waterIntake: doc.diet?.waterIntakeLiters ? String(doc.diet.waterIntakeLiters) : '',
    newProducts: doc.additionalInfo?.newSkincareProducts?.used ? 'yes' : '',
    newProductsDetail: doc.additionalInfo?.newSkincareProducts?.details || '',
    salonVisit: doc.additionalInfo?.recentSalonVisit?.visited ? 'yes' : '',
    salonVisitDetail: doc.additionalInfo?.recentSalonVisit?.details || '',
    pastTreatments: doc.additionalInfo?.pastTreatmentsSurgeries?.had ? 'yes' : '',
    pastTreatmentsDetail: doc.additionalInfo?.pastTreatmentsSurgeries?.details || '',
    symptomDuration: doc.symptomDuration || '',
    previousTreatments: doc.previousTreatments || '',
    currentMedications: doc.currentMedications || '',
    pregnancyStatus: doc.pregnancyStatus || 'not_applicable',
    patientNotes: doc.patientNotes || '',
    consent: false,
    signature: '',
  };
}

module.exports = { toPreConsultDocument, toFormValues };
