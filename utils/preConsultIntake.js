/**
 * Has this guest completed the pre-consultation intake?
 *
 * One answer, used in two places that must never disagree: the status endpoint
 * the app asks before opening the booking flow, and the server-side gate that
 * refuses the booking itself. When these drifted apart the app would happily
 * send a guest to pay for a consultation the API would then refuse — or, worse,
 * accept one the clinic had no intake for.
 *
 * A guest counts as done when either:
 *
 *   · they submitted the form in the app (Submitted / Approved / Reviewed), or
 *   · the clinic already holds their intake on paper. Guests the clinic has
 *     seen filled this in at the desk, often years before the app existed;
 *     blocking a long-standing customer behind a form they have physically
 *     signed would stop them booking. A completed visit, an owned package or a
 *     dermatologist's prescription is that evidence. It is reported as WAIVED,
 *     never as submitted, so nobody mistakes it for an app submission.
 */

const PreConsultForm = require('../models/PreConsultForm');

/** Statuses that mean the guest actually finished and sent the form. */
const SUBMITTED = ['Submitted', 'Approved', 'Reviewed'];

/**
 * @returns {{ done: boolean, waived: boolean, reason: string|null, form: object|null }}
 */
async function intakeStatus(userId) {
  const form = await PreConsultForm.findOne({ userId, status: { $in: SUBMITTED } })
    .select('_id status updatedAt')
    .sort({ updatedAt: -1 })
    .lean();
  if (form) return { done: true, waived: false, reason: null, form };

  const { getGuestEligibility } = require('./guestEligibility');
  const eligibility = await getGuestEligibility(userId).catch(() => null);
  if (eligibility && !eligibility.isNewGuest) {
    const held = eligibility.completedVisits > 0
      ? 'an earlier visit'
      : eligibility.canRedeemPackages ? 'a package bought at the clinic' : 'a clinic prescription';
    return {
      done: true,
      waived: true,
      reason: `Completed at the clinic — we have your form on file from ${held}.`,
      form: null,
    };
  }

  return { done: false, waived: false, reason: null, form: null };
}

module.exports = { intakeStatus, SUBMITTED };
