const Doctor = require('../models/Doctor');
const DoctorTier = require('../models/DoctorTier');
const Consultation = require('../models/Consultation');

/**
 * One place that answers "what does this consultation cost?".
 *
 * The fee used to live in four unrelated places — the app's constants, the
 * CONSULTATION catalogue row that Razorpay charged against, the tier, and the
 * doctor. They only matched because a seed script wrote the same number to
 * each, so changing the price in the panel moved neither the displayed fee nor
 * the amount actually charged.
 *
 * The rule now:
 *
 *   effective fee = Doctor.fee (an admin-approved override, when > 0)
 *                 ?? DoctorTier.fee (the clinic's standard price for that tier)
 *
 * The catalogue row is kept in step so listings agree, but it is no longer the
 * authority — `resolveConsultationAmount` is.
 */

/**
 * Standard fee for a tier, or null when the tier is unknown.
 *
 * Accepts either the tier id ("senior-consultant") or its display title
 * ("Senior Dermatologist"): the booking payload carries `specialistTier` as the
 * title, so an id-only lookup silently missed and this fallback never fired.
 */
async function tierFee(tierIdOrTitle) {
  if (!tierIdOrTitle) return null;
  const value = String(tierIdOrTitle).trim();

  const byId = await DoctorTier.findOne({ tierId: value }).lean();
  if (byId) return byId.fee;

  const byTitle = await DoctorTier.findOne({
    title: new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
  }).lean();
  return byTitle ? byTitle.fee : null;
}

/** What this specific doctor charges, and where that number came from. */
async function effectiveFeeForDoctor(doctorOrId) {
  const doctor = typeof doctorOrId === 'string'
    ? await Doctor.findOne({ doctorId: doctorOrId.toLowerCase() }).lean()
    : doctorOrId;

  if (!doctor) return { fee: null, source: 'unknown', doctor: null };

  if (doctor.fee && doctor.fee > 0) {
    return { fee: doctor.fee, source: 'doctor-override', doctor };
  }

  const standard = await tierFee(doctor.tier);
  return { fee: standard, source: standard === null ? 'unknown' : 'tier', doctor };
}

/**
 * The catalogue entry a tier's consultations are booked against.
 * Matched on the seeded slug so a renamed entry does not break pricing.
 */
const CATALOGUE_SLUG = {
  'senior-consultant': 'senior-dermatologist-consultation',
  'consultant-dermatologist': 'dermatologist-consultation',
};

/**
 * Push a tier's fee onto its catalogue entry.
 *
 * Listings and the app's catalogue read `Consultation.price`, so leaving it
 * stale would show one number and charge another.
 */
async function syncCatalogueForTier(tierId, fee) {
  const slug = CATALOGUE_SLUG[tierId];
  if (!slug || typeof fee !== 'number') return null;
  return Consultation.findOneAndUpdate(
    { slug },
    { price: fee },
    { new: true },
  ).lean();
}

/**
 * Decide what to actually charge for a booking.
 *
 * Prefers the specialist's effective fee; falls back to the catalogue price
 * when the booking carries no specialist (the "any available dermatologist"
 * flow books against the tier entry directly).
 */
async function resolveConsultationAmount({ consultation, specialistId, specialistTier }) {
  if (specialistId) {
    const { fee, source } = await effectiveFeeForDoctor(specialistId);
    if (typeof fee === 'number' && fee > 0) {
      return { amount: fee, source: `doctor:${source}` };
    }
  }

  if (specialistTier) {
    const fee = await tierFee(specialistTier);
    if (typeof fee === 'number' && fee > 0) {
      return { amount: fee, source: 'tier' };
    }
  }

  if (consultation && consultation.price > 0) {
    return { amount: consultation.price, source: 'catalogue' };
  }

  return { amount: null, source: 'unresolved' };
}

module.exports = {
  tierFee,
  effectiveFeeForDoctor,
  syncCatalogueForTier,
  resolveConsultationAmount,
  CATALOGUE_SLUG,
};
