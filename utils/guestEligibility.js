/**
 * What a guest may book right now.
 *
 * The clinic's rule, and it is a clinical one rather than a commercial one:
 * **a treatment is booked only after a dermatologist has actually seen you.**
 * Not "after any past visit" — a guest who has had laser sessions but never a
 * consultation still has to be assessed before booking more.
 *
 * Two things count as having been seen, besides a completed consultation
 * appointment:
 *   · a signed consultation note — a dermatologist wrote the guest up, which
 *     is a consultation in substance whatever the booking was filed as;
 *   · an owned package — it was sold to them at the desk after an assessment,
 *     and blocking its redemption would take away something already paid for.
 *
 * A service may still opt out per-service via `prerequisites.requiresConsultation`.
 *
 * The same answer drives the app's screens and the server's booking gate, so
 * the two can never disagree.
 */
const Booking = require('../models/Booking');
const PackageAssignment = require('../models/PackageAssignment');
const ConsultationNote = require('../models/ConsultationNote');
const { consultationIdsByKind } = require('./listFilters');

const CONSULT_RX = /consult|counsel/i;

const uniq = (arr) => [...new Set(arr.map(String))];

/**
 * The rule itself, with no database in the way.
 *
 * Kept pure and exported so it can be tested against every shape of guest —
 * the previous rule (`canBookTreatment: !isNewGuest`) was wrong in a way that
 * only showed up for one specific kind of person, the guest who had had
 * treatments but never a consultation, and nothing could catch that.
 */
function decide({ completedVisits = 0, completedConsultations = 0, ownedPackages = 0, prescriptions = 0 } = {}) {
  const isNewGuest = completedVisits === 0 && ownedPackages === 0 && prescriptions === 0;
  const hasCompletedConsultation = completedConsultations > 0;
  // A past treatment does NOT open the door — only a dermatologist having
  // actually seen the guest does, whether that is a completed consultation, a
  // written-up note, or a package the desk sold them after assessing them.
  const hasBeenAssessed = hasCompletedConsultation || prescriptions > 0 || ownedPackages > 0;

  /*
   * Two different people read this: someone who has never been, and someone
   * who has been but only for treatments. Telling the second "your first visit
   * with us is a consultation" reads as the clinic not knowing them.
   */
  const message = hasBeenAssessed
    ? null
    : isNewGuest
      ? 'Your first visit with us is a dermatologist consultation. Book one and, once your dermatologist has seen you, treatments open up here.'
      : 'Before we book another treatment, our dermatologist needs to see you. Book a consultation and treatments open up again here.';

  return { isNewGuest, hasCompletedConsultation, hasBeenAssessed, message };
}

async function getGuestEligibility(userId) {
  const { consult } = await consultationIdsByKind();
  const consultSet = new Set(consult.map(String));
  const isConsult = (b) => (b.consultationId ? consultSet.has(String(b.consultationId)) : CONSULT_RX.test(b.externalServiceName || ''));

  const [bookings, ownedPackages, notes] = await Promise.all([
    Booking.find({ userId, status: { $in: require('./bookingStatuses').ATTENDED } }).select('consultationId externalServiceName status').lean(),
    PackageAssignment.countDocuments({ userId, status: { $in: ['Active', 'Completed'] } }),
    ConsultationNote.find({ userId, status: 'Completed' }).select('prescription.productId assignedServices completedAt').lean(),
  ]);

  const completedVisits = bookings.filter((b) => b.status === 'Completed').length;
  const completedConsultations = bookings.filter((b) => b.status === 'Completed' && isConsult(b)).length;
  const { isNewGuest, hasCompletedConsultation, hasBeenAssessed, message } = decide({
    completedVisits, completedConsultations, ownedPackages, prescriptions: notes.length,
  });

  return {
    isNewGuest,
    completedVisits,
    hasCompletedConsultation,
    hasBeenAssessed,
    canBookConsultation: true,
    canBookTreatment: hasBeenAssessed,
    canRedeemPackages: ownedPackages > 0,
    prescriptions: notes.length,
    prescribedProductIds: uniq(notes.flatMap((n) => (n.prescription || []).map((p) => p.productId).filter(Boolean))),
    prescribedServiceIds: uniq(notes.flatMap((n) => (n.assignedServices || []).map((s) => s.serviceId).filter(Boolean))),
    message,
  };
}

/**
 * The server-side gate for booking a service. Returns null when allowed, or
 * `{ status, code, message }` for the controller to send. Consultations are
 * always allowed; a treatment needs an existing guest.
 */
async function serviceBookingBlock(userId, consultation) {
  if (!consultation) return null;
  const { consult } = await consultationIdsByKind();
  const isConsultation = consult.map(String).includes(String(consultation._id)) || CONSULT_RX.test(consultation.name || '');
  const prereq = consultation.prerequisites || {};

  // Per-service prerequisites (Zenoti's "must have finished X within N days").
  const required = (prereq.serviceIds || []).map(String).filter(Boolean);
  if (required.length) {
    const Consultation = require('../models/Consultation');
    const targets = await Consultation.find({ $or: [{ id: { $in: required } }, { slug: { $in: required } }] }).select('_id name').lean();
    if (targets.length) {
      const since = Number(prereq.withinDays) > 0 ? new Date(Date.now() - Number(prereq.withinDays) * 864e5) : null;
      const done = await Booking.exists({
        userId,
        status: 'Completed',
        consultationId: { $in: targets.map((t) => t._id) },
        ...(since ? { $or: [{ checkOutTime: { $gte: since } }, { checkOutTime: null, preferredDate: { $gte: since } }] } : {}),
      });
      if (!done) {
        const names = targets.map((t) => t.name).join(' or ');
        return {
          status: 403,
          code: 'PREREQUISITE_REQUIRED',
          message: prereq.note || `${consultation.name} needs a completed ${names}${since ? ` in the last ${prereq.withinDays} days` : ''} first.`,
        };
      }
    }
  }

  /*
   * A dermatologist consultation needs the pre-consultation intake first. The
   * app redirects to the form, but the redirect is a convenience — this is the
   * rule. Without it a guest could reach the payment step straight from a deep
   * link and the dermatologist would meet them with no history at all.
   */
  if (isConsultation) {
    const { intakeStatus } = require('./preConsultIntake');
    const intake = await intakeStatus(userId);
    if (intake.done) return null;
    return {
      status: 403,
      code: 'PRE_CONSULT_REQUIRED',
      message: 'Please complete your pre-consultation form before booking a dermatologist consultation.',
    };
  }
  // A service may opt out of (or into) the consultation-first rule.
  if (prereq.requiresConsultation === false) return null;
  const eligibility = await getGuestEligibility(userId);
  if (prereq.requiresConsultation === true) {
    // Strict: a completed consultation specifically, not just any past visit.
    if (eligibility.hasCompletedConsultation) return null;
    return {
      status: 403,
      code: 'CONSULTATION_FIRST',
      message: prereq.note || `${consultation.name} is booked after a dermatologist consultation. Book a consultation first.`,
    };
  }
  // Clinic default: the guest must have been assessed by a dermatologist.
  if (eligibility.canBookTreatment) return null;
  return {
    status: 403,
    code: 'CONSULTATION_FIRST',
    message: eligibility.message || 'Please book a dermatologist consultation before this treatment.',
  };
}

module.exports = { getGuestEligibility, serviceBookingBlock, decide };
