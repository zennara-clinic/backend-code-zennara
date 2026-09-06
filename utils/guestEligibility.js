/**
 * What a guest may book right now.
 *
 * The clinic's rule: a NEW guest's first appointment is a dermatologist
 * consultation. Treatments, and packages, come after a consultation (or, for
 * an existing clinic guest, after any completed visit or an owned package).
 * The same answer drives the app's screens and the server's booking gate, so
 * the two can never disagree.
 */
const Booking = require('../models/Booking');
const PackageAssignment = require('../models/PackageAssignment');
const ConsultationNote = require('../models/ConsultationNote');
const { consultationIdsByKind } = require('./listFilters');

const CONSULT_RX = /consult|counsel/i;

const uniq = (arr) => [...new Set(arr.map(String))];

async function getGuestEligibility(userId) {
  const { consult } = await consultationIdsByKind();
  const consultSet = new Set(consult.map(String));
  const isConsult = (b) => (b.consultationId ? consultSet.has(String(b.consultationId)) : CONSULT_RX.test(b.externalServiceName || ''));

  const [bookings, ownedPackages, notes] = await Promise.all([
    Booking.find({ userId, status: { $in: ['Completed', 'In Progress'] } }).select('consultationId externalServiceName status').lean(),
    PackageAssignment.countDocuments({ userId, status: { $in: ['Active', 'Completed'] } }),
    ConsultationNote.find({ userId, status: 'Completed' }).select('prescription.productId assignedServices completedAt').lean(),
  ]);

  const completedVisits = bookings.filter((b) => b.status === 'Completed').length;
  const completedConsultations = bookings.filter((b) => b.status === 'Completed' && isConsult(b)).length;
  const isNewGuest = completedVisits === 0 && ownedPackages === 0 && notes.length === 0;

  return {
    isNewGuest,
    completedVisits,
    hasCompletedConsultation: completedConsultations > 0,
    canBookConsultation: true,
    canBookTreatment: !isNewGuest,
    canRedeemPackages: ownedPackages > 0,
    prescriptions: notes.length,
    prescribedProductIds: uniq(notes.flatMap((n) => (n.prescription || []).map((p) => p.productId).filter(Boolean))),
    prescribedServiceIds: uniq(notes.flatMap((n) => (n.assignedServices || []).map((s) => s.serviceId).filter(Boolean))),
    message: isNewGuest
      ? 'Your first visit with us is a dermatologist consultation. Book one and, once your dermatologist has seen you, treatments open up here.'
      : null,
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

  if (isConsultation) return null;
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
  // Clinic default: an existing guest (any completed visit, package or prescription) may book.
  if (eligibility.canBookTreatment) return null;
  return {
    status: 403,
    code: 'CONSULTATION_FIRST',
    message: eligibility.message || 'Please book a dermatologist consultation before this treatment.',
  };
}

module.exports = { getGuestEligibility, serviceBookingBlock };
