/**
 * Has this guest completed the pre-consultation intake — and HOW?
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
 *
 * Since 2026-09-12 the answer also carries a NAME. "Waived" was only ever a
 * boolean the app turned into a greyed-out card and staff could not see at
 * all — 6,071 guests of 7,081 sit in that state, every one with a signed sheet
 * in a folder at the desk. So the same rule now reports one of three states
 * that every screen shows the same way (`labelFor`):
 *
 *   digital  a submitted form exists           (done, not waived)
 *   paper    waived by clinic evidence         (done, waived)
 *   none     neither                           (not done)
 *
 * The done/waived pair is unchanged — the gate and the app read those — the
 * state is a name for what they already meant.
 */

const mongoose = require('mongoose');
const PreConsultForm = require('../models/PreConsultForm');

/** Statuses that mean the guest actually finished and sent the form. */
const SUBMITTED = ['Submitted', 'Approved', 'Reviewed'];

const LABELS = { digital: 'Digital', paper: 'On paper', none: 'Not yet' };

/** The one wording for a state, so the app, both panels and exports agree. */
const labelFor = (state) => LABELS[state] || LABELS.none;

/**
 * What "the clinic has already seen this guest" means, as counts.
 *
 * The same three facts guestEligibility.decide() folds into `isNewGuest`
 * (completedVisits, ownedPackages, prescriptions) — deliberately the same, so
 * a guest the eligibility rule treats as known is one whose intake is on
 * paper, and vice versa. If that rule ever grows a fourth kind of evidence
 * it must be added here too.
 */
const PACKAGE_OWNED = ['Active', 'Completed'];

const asObjectId = (value) => {
  const key = value && typeof value === 'object' && value._id ? String(value._id) : String(value || '');
  return /^[a-f0-9]{24}$/i.test(key) ? new mongoose.Types.ObjectId(key) : null;
};

/**
 * The lookups, on one object so a test can swap them for stubs (`_deps`)
 * without a database — the way utils/zenMembership does.
 */
const deps = {
  /** The newest submitted form: ids, status, dates and provenance only. */
  latestSubmitted: (userId) => PreConsultForm.findOne({ userId, status: { $in: SUBMITTED } })
    /*
     * `clientSignature` is here for inferOrigin (an old row is walk-in or app
     * by its signature format) and is stripped before the form leaves this
     * file. Nothing encrypted is selected, so a lean read is safe.
     */
    .select('_id status updatedAt createdAt dateOfVisit origin clientSignature')
    .sort({ updatedAt: -1 })
    .lean(),
  evidence: async (userId) => {
    const Booking = require('../models/Booking');
    const PackageAssignment = require('../models/PackageAssignment');
    const ConsultationNote = require('../models/ConsultationNote');
    const [completedVisits, packages, prescriptions] = await Promise.all([
      Booking.countDocuments({ userId, status: 'Completed' }),
      PackageAssignment.countDocuments({ userId, status: { $in: PACKAGE_OWNED } }),
      ConsultationNote.countDocuments({ userId, status: 'Completed' }),
    ]);
    return { completedVisits, packages, prescriptions };
  },
};

const hasEvidence = (evidence) => Boolean(evidence) && (
  evidence.completedVisits > 0 || evidence.packages > 0 || evidence.prescriptions > 0
);

/** Which of the three states a form-or-evidence pair means. Pure, for the tests. */
function stateOf({ form = null, evidence = null } = {}) {
  if (form) return 'digital';
  return hasEvidence(evidence) ? 'paper' : 'none';
}

const reasonFor = (evidence) => {
  const held = evidence.completedVisits > 0
    ? 'an earlier visit'
    : evidence.packages > 0 ? 'a package bought at the clinic' : 'a clinic prescription';
  return `Completed at the clinic — we have your form on file from ${held}.`;
};

/**
 * @returns {{
 *   state: 'digital'|'paper'|'none', done: boolean, waived: boolean,
 *   reason: string|null, form: object|null, origin: object|null,
 *   evidence: { completedVisits: number, packages: number, prescriptions: number }
 * }}
 */
async function intakeStatus(userId, lookups = deps) {
  const [found, evidence] = await Promise.all([
    lookups.latestSubmitted(userId),
    lookups.evidence(userId).catch(() => ({ completedVisits: 0, packages: 0, prescriptions: 0 })),
  ]);

  if (found) {
    const origin = PreConsultForm.inferOrigin(found);
    // The signature was read for inferOrigin only; it never travels with the status.
    const { clientSignature, ...form } = found;
    return { state: 'digital', done: true, waived: false, reason: null, form, origin, evidence };
  }

  if (hasEvidence(evidence)) {
    return {
      state: 'paper',
      done: true,
      waived: true,
      reason: reasonFor(evidence),
      form: null,
      origin: null,
      evidence,
    };
  }

  return { state: 'none', done: false, waived: false, reason: null, form: null, origin: null, evidence };
}

/**
 * The same answer for a whole page of guests, in bulk.
 *
 * A patients list of 100 rows must not make 400 queries. One query per source
 * of truth instead — submitted forms, completed visits, owned packages,
 * signed notes — each keyed by guest, then folded per row.
 *
 * The forms query is an aggregate rather than a find so the signature can be
 * cut to its first characters in the database: inferOrigin needs to know only
 * whether it begins "data:image/", and a walk-in signature is tens of
 * kilobytes of PNG per row.
 *
 * @returns {Map<string, { state, formId, origin, lastVisitAt }>}
 */
async function intakeStatesFor(userIds) {
  const ids = [...new Map((userIds || []).map(asObjectId).filter(Boolean).map((id) => [String(id), id])).values()];
  const out = new Map();
  if (!ids.length) return out;

  const Booking = require('../models/Booking');
  const PackageAssignment = require('../models/PackageAssignment');
  const ConsultationNote = require('../models/ConsultationNote');

  const [forms, visits, packageOwners, prescribed] = await Promise.all([
    PreConsultForm.aggregate([
      { $match: { userId: { $in: ids }, status: { $in: SUBMITTED } } },
      { $sort: { updatedAt: -1 } },
      {
        $group: {
          _id: '$userId',
          formId: { $first: '$_id' },
          origin: { $first: '$origin' },
          createdAt: { $first: '$createdAt' },
          clientSignature: { $first: { $substrCP: [{ $ifNull: ['$clientSignature', ''] }, 0, 11] } },
        },
      },
    ]),
    Booking.aggregate([
      { $match: { userId: { $in: ids }, status: 'Completed' } },
      {
        $group: {
          _id: '$userId',
          // The visit's own instant (Booking.eventAt), with the older columns
          // as a fallback for rows written before it existed.
          lastVisitAt: { $max: { $ifNull: ['$eventAt', { $ifNull: ['$checkOutTime', { $ifNull: ['$confirmedDate', '$preferredDate'] }] }] } },
        },
      },
    ]),
    PackageAssignment.distinct('userId', { userId: { $in: ids }, status: { $in: PACKAGE_OWNED } }),
    ConsultationNote.distinct('userId', { userId: { $in: ids }, status: 'Completed' }),
  ]);

  const formBy = new Map(forms.map((f) => [String(f._id), f]));
  const visitBy = new Map(visits.map((v) => [String(v._id), v.lastVisitAt || null]));
  const withPackage = new Set(packageOwners.map(String));
  const withRx = new Set(prescribed.map(String));

  for (const id of ids) {
    const key = String(id);
    const form = formBy.get(key) || null;
    const evidence = {
      completedVisits: visitBy.has(key) ? 1 : 0,
      packages: withPackage.has(key) ? 1 : 0,
      prescriptions: withRx.has(key) ? 1 : 0,
    };
    out.set(key, {
      state: stateOf({ form, evidence }),
      formId: form ? form.formId : null,
      origin: form ? PreConsultForm.inferOrigin(form) : null,
      lastVisitAt: visitBy.get(key) || null,
    });
  }
  return out;
}

/** The `intake` block a list row carries — one shape for every list. */
function intakeRow(entry) {
  const state = entry?.state || 'none';
  return {
    state,
    label: labelFor(state),
    formId: entry?.formId || null,
    capturedOn: entry?.origin?.capturedOn || null,
    channel: entry?.origin?.channel || null,
    lastVisitAt: entry?.lastVisitAt || null,
  };
}

module.exports = { intakeStatus, intakeStatesFor, intakeRow, stateOf, labelFor, SUBMITTED, _deps: deps };
