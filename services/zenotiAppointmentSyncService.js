/**
 * Zenoti appointment book -> first-class local Booking reconciliation.
 *
 * The older integration stored appointments only inside ZenotiGuestData. That
 * made them visible as history cards but invisible to the actual reception,
 * doctor, therapist, analytics and customer appointment flows. This service
 * performs an idempotent upsert keyed by Zenoti's appointment id so a clinic
 * appointment behaves exactly like an app booking everywhere in Zennara.
 */

const Booking = require('../models/Booking');
const Branch = require('../models/Branch');
const Consultation = require('../models/Consultation');
const User = require('../models/User');
const ZenotiSyncRun = require('../models/ZenotiSyncRun');
const zenoti = require('./zenotiService');
const { provisionUserFromGuest, hydrateGuestIdentity } = require('./zenotiSyncService');
const { CENTERS, branchNameForCenter, publicEmail, isPlaceholderEmail, clinicInstant } = require('../config/zenoti');
const Doctor = require('../models/Doctor');
const ZenotiPractitioner = require('../models/ZenotiPractitioner');
const { buildDoctorMatcher, canonicalName, tierTitle } = require('../utils/dermatologistMatch');
const logger = require('../utils/logger');

let appointmentSyncRunning = false;

const norm = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');

function clinicDay(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(value));
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function appointmentLocalParts(value, utcValue = null) {
  const raw = String(value || '');
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  const explicitZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  // Zenoti's `start_time` is normally a clinic wall-clock string. Preserve
  // that written day/time. If it ever supplies UTC (or a non-IST offset),
  // convert the instant to Asia/Kolkata instead of silently using UTC fields.
  if (match && (!explicitZone || /\+05:?30$/i.test(raw))) {
    return { date: new Date(`${match[1]}T00:00:00+05:30`), day: match[1], time: match[2] };
  }

  const instant = new Date(utcValue || value);
  if (Number.isNaN(instant.getTime())) return { date: instant, day: null, time: null };
  const rows = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(instant);
  const part = (type) => rows.find((row) => row.type === type)?.value || '00';
  const day = `${part('year')}-${part('month')}-${part('day')}`;
  const hour = part('hour') === '24' ? '00' : part('hour');
  return { date: new Date(`${day}T00:00:00+05:30`), day, time: `${hour}:${part('minute')}` };
}

function clinicDate(value) {
  if (!value) return null;
  const raw = String(value);
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const date = new Date(hasZone ? raw : `${raw}+05:30`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Zenoti appointment enum/progress -> the local lifecycle enum. */
function localStatus(appointment) {
  const status = String(appointment.status ?? '').toLowerCase();
  const progress = Number(appointment.progress);
  if (status === '-2' || status === 'no show') return 'No Show';
  if (status === '-1' || status === '21' || /cancel|void/.test(status)) return 'Cancelled';
  if (appointment.isCompleted || progress === 2 || status === '1' || status === 'closed' || status === 'completed') return 'Completed';
  if (appointment.isStarted || progress === 1 || status === '2' || status === 'checkin') return 'In Progress';
  // A row in the center appointment book is a real reserved appointment even
  // when Zenoti uses its default/new status (0).
  return 'Confirmed';
}

/**
 * Reconcile Zenoti's view of an appointment with what staff recorded here.
 *
 * Zenoti is the system of record for an appointment booked in Zenoti, but the
 * desk may check a guest in, out, or mark them completed in THIS panel while
 * Zenoti still shows the visit as merely booked. Without this rule the next
 * two-minute poll would push that visit straight back to "Confirmed" (that
 * regression is exactly the kind of glitch that made the day book untrustworthy).
 *
 *  - Zenoti's terminal states (Cancelled, No Show, Completed) always win.
 *  - Otherwise, if Zenoti's own status/progress has NOT changed since we last
 *    read it, a state the desk advanced locally is kept.
 *  - As soon as Zenoti moves (checked in, closed, cancelled…), Zenoti wins.
 */
const STATUS_RANK = { 'Awaiting Confirmation': 0, Confirmed: 1, Rescheduled: 1, 'In Progress': 2, Completed: 3 };
const ZENOTI_TERMINAL = new Set(['Cancelled', 'No Show', 'Completed']);
function mergeStatus(booking, appointment, zenotiStatus, isNew) {
  if (isNew || !booking.status) return zenotiStatus;
  const prev = booking.zenotiSource || {};
  const zenotiChanged = !('status' in prev)
    || String(prev.status ?? '') !== String(appointment.status ?? '')
    || Number(prev.progress ?? 0) !== Number(appointment.progress ?? 0);
  if (ZENOTI_TERMINAL.has(zenotiStatus)) return zenotiStatus;
  if (zenotiChanged) return zenotiStatus;
  const local = booking.status;
  if (local === 'Cancelled' || local === 'No Show') return local; // desk decision, Zenoti unchanged
  if ((STATUS_RANK[local] ?? 0) > (STATUS_RANK[zenotiStatus] ?? 0)) return local;
  return zenotiStatus;
}

/**
 * Appointments that were deleted or moved in Zenoti simply stop appearing in
 * the centre feed (cancelled and no-show ones still appear, because we ask
 * for them). Left alone, such a row would sit in our diary for ever as a
 * confirmed visit nobody is coming to — and block a dermatologist slot. Mark
 * those rows cancelled locally. Never writes to Zenoti, never emails.
 */
async function retireVanishedAppointments({ centerId, from, to, seenIds, runStartedAt, feedCount }) {
  // An empty feed for a whole window is more likely an API hiccup than a
  // clinic with no appointments at all — refuse to retire anything on it.
  if (!feedCount) return 0;
  const dayStart = new Date(`${from}T00:00:00+05:30`);
  const dayEnd = new Date(`${to}T23:59:59.999+05:30`);
  const filter = {
    source: 'zenoti',
    'zenotiSource.centerId': centerId,
    status: { $in: ['Awaiting Confirmation', 'Confirmed', 'Rescheduled', 'In Progress'] },
    preferredDate: { $gte: dayStart, $lte: dayEnd },
    zenotiAppointmentId: { $nin: [...seenIds] },
    zenotiLastInboundAt: { $lt: runStartedAt },
  };
  const result = await Booking.updateMany(filter, {
    $set: {
      status: 'Cancelled',
      cancellationReason: 'Removed from the clinic diary in Zenoti',
      cancelledAt: new Date(),
      slotHeld: false,
      // A distinct marker so that, should the appointment reappear in the
      // feed, mergeStatus sees Zenoti "changed" and restores Zenoti's status.
      'zenotiSource.status': 'vanished',
      'zenotiSource.vanishedAt': new Date(),
      zenotiSyncStatus: 'synced',
      zenotiSyncError: null,
      zenotiLastInboundAt: new Date(),
    },
  });
  return result.modifiedCount || 0;
}

async function lookupContext() {
  const [consultations, branches, doctors, practitioners] = await Promise.all([
    Consultation.find({}).select('_id name slug zenotiServiceId').lean(),
    Branch.find({}).select('_id name').lean(),
    Doctor.find({}).select('doctorId name tier').lean(),
    ZenotiPractitioner.find({ active: true }).lean(),
  ]);
  const consultationByName = new Map(consultations.map((c) => [norm(c.name), c]));
  // Zenoti's own service id is the reliable link; the name is the fallback for
  // services not yet mirrored.
  const consultationByZenotiId = new Map(consultations.filter((c) => c.zenotiServiceId).map((c) => [String(c.zenotiServiceId).toLowerCase(), c]));
  const branchByName = new Map(branches.map((b) => [norm(b.name), b]));
  const doctorById = new Map(doctors.map((doctor) => [String(doctor.doctorId), doctor]));
  const practitionerById = new Map(practitioners.map((row) => [String(row.zenotiEmployeeId).toLowerCase(), row]));
  const practitionerByName = new Map(practitioners.map((row) => [row.normalizedName || canonicalName(row.name), row]));
  return {
    consultationByName,
    consultationByZenotiId,
    branchByName,
    doctorById,
    practitionerById,
    practitionerByName,
    matchDoctor: buildDoctorMatcher(doctors),
  };
}

function amountOf(appointment) {
  const n = Number(appointment.price);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Upsert one normalised Zenoti appointment. `user` may be supplied for the
 * guest-history backfill; center polling provisions it from appointment.guest.
 */
/**
 * A reference number for a mirrored appointment that cannot collide.
 *
 * The old form was `ZNT` + the first 20 hex characters of Zenoti's appointment
 * GUID. Those 20 characters never collide between two appointments — but the
 * reference outlives the row's identity. An earlier version of the invoice
 * adoption below let a second service in a multi-service visit re-point an
 * existing booking at its own appointment id, leaving that row holding a
 * reference derived from the FIRST appointment. When the first appointment came
 * back on the next sync it could never be inserted: its natural reference was
 * already taken, `save()` threw a duplicate-key error, and the row was counted
 * as failed and dropped. It repeated on every sync, for ever.
 *
 * So derive the reference, then verify the holder is this very appointment;
 * otherwise fall through to progressively longer, still deterministic forms.
 * Same appointment in, same reference out — re-running creates no duplicates.
 */
async function uniqueZenotiReference(appointmentId) {
  const hex = String(appointmentId).replace(/-/g, '').toUpperCase();
  const candidates = [`ZNT${hex.slice(0, 20)}`, `ZNT${hex}`];
  for (let i = 2; i <= 9; i += 1) candidates.push(`ZNT${hex}X${i}`);
  for (const ref of candidates) {
    const holder = await Booking.findOne({ referenceNumber: ref })
      .select('zenotiAppointmentId').lean();
    if (!holder) return ref;
    if (String(holder.zenotiAppointmentId || '').toLowerCase() === String(appointmentId).toLowerCase()) return ref;
  }
  // Unreachable in practice; keeps the caller from inserting a null reference.
  return `ZNT${hex}${Date.now().toString(36).toUpperCase()}`;
}

/** Did the guest actually attend, according to a Zenoti appointment record? */
function appointmentAttended(appointment) {
  const status = String(appointment.status ?? '');
  return Boolean(appointment.checkinTime) || Boolean(appointment.actualStartTime)
    || Number(appointment.progress) >= 1 || appointment.isStarted || appointment.isCompleted
    || status === '1' || status === '2';
}

async function upsertAppointment(appointment, { user = null, context = null, verified = false } = {}) {
  if (!appointment?.id) return { outcome: 'skipped', reason: 'missing appointment id' };
  const guest = appointment.guest;
  let owner = user || (guest ? await provisionUserFromGuest(guest, { quiet: true }) : null);
  if (!owner) return { outcome: 'skipped', reason: 'missing guest' };
  // The guest-history crawl used to hand over a projection without name/phone/
  // email, so every mirrored visit was saved as "Zennara Guest" with a blank
  // number — and re-saved that way on every pass. Load the identity once.
  if (!owner.fullName || owner.phone === undefined || owner.email === undefined) {
    const full = await User.findById(owner._id).select('fullName phone email zenotiCenterId').lean();
    if (full) owner = { ...(typeof owner.toObject === 'function' ? owner.toObject() : owner), ...full };
  }

  const ctx = context || await lookupContext();
  const branchName = appointment.branchName || branchNameForCenter(appointment.centerId || owner.zenotiCenterId);
  const branch = ctx.branchByName.get(norm(branchName));
  const consultation = (appointment.serviceId && ctx.consultationByZenotiId?.get(String(appointment.serviceId).toLowerCase()))
    || ctx.consultationByName.get(norm(appointment.serviceName));
  const parts = appointmentLocalParts(appointment.startTime, appointment.startTimeUtc);
  if (!parts.day || !parts.time || Number.isNaN(parts.date.getTime())) {
    return { outcome: 'skipped', reason: 'invalid appointment time' };
  }

  // App-created bookings may have been linked with an invoice id by the old
  // confirm parser. Match that record before inserting so rollout creates no
  // duplicates; every subsequent pass uses the real appointment id.
  let booking = await Booking.findOne({ zenotiAppointmentId: appointment.id });
  if (!booking && appointment.invoiceId) {
    booking = await Booking.findOne({
      userId: owner._id,
      $or: [
        { zenotiInvoiceId: appointment.invoiceId },
        { zenotiAppointmentId: appointment.invoiceId },
      ],
      // One invoice covers every service in a visit, so this fallback must
      // never adopt a row already claimed by a DIFFERENT appointment — that
      // made each service in a multi-service visit overwrite the previous
      // one, leaving the guest with a single treatment instead of all of
      // them. Only an unclaimed row (a legacy app booking, or one the old
      // parser linked by invoice id) may be adopted.
      zenotiAppointmentId: { $in: [null, appointment.id, appointment.invoiceId] },
    });
  }
  const isNew = !booking;
  // "Booked on" is Zenoti's creation_date (centre diary / detail only). Without
  // it every mirrored visit was stamped with the crawl day, so 32,000 bookings
  // read as booked on 23–25 Aug. Preferring the UTC form avoids the zone guess.
  const bookedAt = clinicInstant(appointment.createdAtUtc ? `${appointment.createdAtUtc}Z` : appointment.createdAt);
  if (!booking) {
    booking = new Booking({
      userId: owner._id,
      source: 'zenoti',
      ...(bookedAt ? { createdAt: bookedAt } : {}),
      // The generic four-digit random reference collides during bulk history
      // imports. Zenoti's GUID gives this row a stable reference, and
      // uniqueZenotiReference guarantees it is not already held by a different
      // appointment — see the note there.
      referenceNumber: await uniqueZenotiReference(appointment.id),
    });
  }

  let status = localStatus(appointment);
  // A visit checked in on a past clinic day but never closed in Zenoti is a
  // finished visit, not something "in progress" today — the app's Upcoming
  // list and the panel's day book must not keep showing it as live.
  if (status === 'In Progress' && parts.day < clinicDay()) status = 'Completed';
  // A no-show or cancellation from the feed that contradicts attendance the
  // desk already recorded here is re-read from Zenoti before it is applied.
  // If Zenoti's own detail shows the guest checked in / started / closed, the
  // feed row was stale (or an echo) and the attended state is kept.
  if (!isNew && !verified && (status === 'No Show' || status === 'Cancelled')
      && ['In Progress', 'Completed'].includes(booking.status) && appointment.id) {
    try {
      const detail = await zenoti.getAppointment(appointment.id);
      if (detail && appointmentAttended(detail)) {
        logger.warn('Zenoti terminal state contradicted by appointment detail; keeping attended state', { appointmentId: appointment.id, feedStatus: appointment.status, detailStatus: detail.status });
        appointment = { ...appointment, status: detail.status, progress: detail.progress, checkinTime: detail.checkinTime || appointment.checkinTime };
        status = localStatus(appointment);
      }
    } catch (error) {
      logger.warn('Zenoti appointment detail re-check failed; applying feed state', { appointmentId: appointment.id, error: error.message });
    }
  }
  status = mergeStatus(booking, appointment, status, isNew);
  booking.userId = owner._id;
  if (consultation) booking.consultationId = consultation._id;
  /*
   * Identity on the mirrored booking.
   *
   * "Zennara Guest" is a last-resort label, not a value Zenoti ever sends. It
   * may only be written when we have exhausted every real source, and it must
   * never overwrite a name already on the row — that was the bug that made
   * real patients turn back into guests on a later sync pass.
   */
  let ownerName = owner.fullName || guest?.fullName || null;
  if (!ownerName && (owner.zenotiGuestId || guest?.zenotiGuestId)) {
    // Ask Zenoti directly before giving up on the name.
    const hydrated = await hydrateGuestIdentity({
      zenotiGuestId: owner.zenotiGuestId || guest.zenotiGuestId,
    }).catch(() => null);
    if (hydrated?.fullName) {
      ownerName = hydrated.fullName;
      // Heal the account too, so the next pass has it locally.
      await User.updateOne(
        { _id: owner._id, $or: [{ fullName: { $in: [null, '', 'Zennara Guest'] } }] },
        { $set: { fullName: hydrated.fullName } },
      ).catch(() => {});
    }
  }
  if (ownerName && ownerName !== 'Zennara Guest') booking.fullName = ownerName;
  else if (!booking.fullName) booking.fullName = 'Zennara Guest';
  const ownerPhone = owner.phone || guest?.phone || null;
  if (ownerPhone) booking.mobileNumber = ownerPhone;
  else if (booking.mobileNumber === undefined) booking.mobileNumber = '';
  const ownerEmail = publicEmail(owner.email) || publicEmail(guest?.email) || null;
  if (ownerEmail) booking.email = ownerEmail;
  // Only a Zenoti-owned row may carry an empty email (its schema allows it);
  // an app/reception booking keeps whatever it was created with.
  else if (booking.source === 'zenoti' && (!booking.email || isPlaceholderEmail(booking.email))) booking.email = '';
  booking.branchId = branch?._id || null;
  booking.preferredLocation = branch?.name || branchName;
  booking.preferredDate = parts.date;
  booking.preferredTimeSlots = [parts.time];
  booking.slotTime = parts.time;
  booking.confirmedDate = parts.date;
  booking.confirmedTime = parts.time;
  booking.status = status;
  // The centre appointment book reports price 0; the guest-history feed has the
  // invoiced value. Never let a zero overwrite a known amount.
  const price = amountOf(appointment);
  if (price > 0 || isNew) booking.amount = price > 0 ? price : (booking.amount || 0);
  booking.source = booking.source === 'zenoti' || isNew ? 'zenoti' : booking.source;
  // A Zenoti visit is settled at the desk, never through the app's gateway.
  booking.paymentMethod = booking.source === 'zenoti' ? 'Clinic' : (booking.paymentMethod || 'Other');
  // Zenoti calls every service provider a therapist. First classify the
  // employee against the separately mirrored Zenoti Doctor roster; only then
  // may it be linked to an onboarded app Doctor. This prevents aestheticians
  // with a coincidental name token from receiving a dermatologist's revenue.
  const rawTherapistId = String(appointment.therapistId || '').toLowerCase() || null;
  const rawTherapistName = appointment.therapistName || '';
  const external = (rawTherapistId && ctx.practitionerById?.get(rawTherapistId))
    || (rawTherapistName && ctx.practitionerByName?.get(canonicalName(rawTherapistName)))
    || null;
  const looksDoctor = /^\s*dr\.?\s*/i.test(rawTherapistName);
  const derm = external?.onboardedDoctorId
    ? ctx.doctorById?.get(String(external.onboardedDoctorId))
    : (looksDoctor && ctx.matchDoctor ? ctx.matchDoctor(rawTherapistName) : null);

  booking.zenotiTherapistId = external?.zenotiEmployeeId || rawTherapistId;
  booking.zenotiTherapistName = external?.name || rawTherapistName;
  if (rawTherapistName) booking.therapistName = rawTherapistName;
  if (derm) {
    booking.specialistId = derm.doctorId;
    booking.specialistName = derm.name;
    booking.specialistTier = tierTitle(derm);
  } else if (external || looksDoctor) {
    // A real Zenoti doctor who has not been onboarded still participates in
    // reporting and filters, but has no local specialistId/app profile.
    booking.specialistId = null;
    booking.specialistName = external?.name || rawTherapistName.replace(/^dr\.?\s*/i, 'Dr ');
    booking.specialistTier = 'Zenoti practitioner';
  } else if (booking.source === 'zenoti' || isNew) {
    // It is a treatment therapist, not a dermatologist.
    booking.specialistId = null;
    booking.specialistName = null;
    booking.specialistTier = null;
  }
  // A completed clinic visit with a value was settled on the Zenoti invoice.
  if (status === 'Completed' && (booking.amount || 0) > 0 && booking.paymentStatus !== 'paid') {
    booking.paymentStatus = 'paid';
    booking.paidAt = clinicDate(appointment.actualCompletedTime) || parts.date || new Date();
  }
  booking.room = appointment.roomName || booking.room || '';
  booking.checkInTime = clinicDate(appointment.checkinTime) || booking.checkInTime;
  booking.checkOutTime = clinicDate(appointment.actualCompletedTime) || booking.checkOutTime;
  if (appointment.actualStartTime && !booking.checkInTime) booking.checkInTime = clinicDate(appointment.actualStartTime);
  if (status === 'Cancelled' && !booking.cancelledAt) booking.cancelledAt = new Date();
  booking.zenotiAppointmentId = appointment.id;
  booking.zenotiAppointmentGroupId = appointment.appointmentGroupId || null;
  booking.zenotiAppointmentSegmentId = appointment.appointmentSegmentId || null;
  booking.zenotiInvoiceId = appointment.invoiceId || null;
  booking.zenotiInvoiceItemId = appointment.invoiceItemId || null;
  booking.zenotiServiceId = appointment.serviceId || null;
  booking.externalServiceName = appointment.serviceName || null;
  booking.externalServiceCategory = appointment.serviceSubCategory || appointment.serviceCategory || null;
  booking.zenotiSource = {
    status: appointment.status,
    progress: appointment.progress,
    source: appointment.source,
    centerId: appointment.centerId || owner.zenotiCenterId || null,
    startTime: appointment.startTime || null,
    startTimeUtc: appointment.startTimeUtc || null,
    endTime: appointment.endTime || null,
    endTimeUtc: appointment.endTimeUtc || null,
    invoiceNumber: appointment.invoiceNumber || null,
    receiptNumber: appointment.receiptNumber || null,
    packageId: appointment.packageId || null,
    packageName: appointment.packageName || null,
    formId: appointment.formId || null,
    prescriptionSigned: appointment.isPrescriptionSigned ?? null,
    hasUnexpiredPackages: Boolean(appointment.hasUnexpiredPackages),
    membershipApplied: Boolean(appointment.membershipApplied),
    equipmentName: appointment.equipmentName || null,
    // Keep what the guest-history feed cannot give us once the diary has.
    createdAt: bookedAt || booking.zenotiSource?.createdAt || null,
    createdByName: appointment.createdByName || booking.zenotiSource?.createdByName || null,
  };
  booking.zenotiSyncStatus = 'synced';
  booking.zenotiSyncError = null;
  booking.zenotiSyncedAt = new Date();
  booking.zenotiLastInboundAt = new Date();
  if (appointment.notes && !booking.notes) booking.notes = appointment.notes;

  // Mark the document so Booking's outbound post-save hook does not echo the
  // imported lifecycle state back to Zenoti.
  booking.$locals.skipZenotiWrite = true;
  try {
    await booking.save({ validateModifiedOnly: !isNew });
  } catch (error) {
    // A reference number that was free when we generated it can still be taken
    // by a concurrent pass. Re-derive once and retry rather than losing the
    // appointment — the old code counted this as `failed` and moved on, which
    // is how thousands of visits stayed missing across every sync.
    if (isNew && error && error.code === 11000) {
      booking.referenceNumber = await uniqueZenotiReference(appointment.id);
      await booking.save({ validateModifiedOnly: false });
    } else {
      throw error;
    }
  }
  // Mongoose makes createdAt immutable on an existing document, so a row that
  // was first mirrored from the guest-history feed (no creation_date) is
  // corrected through the driver once the diary supplies the real booked-on
  // instant. Guarded to a real difference so the common path costs nothing.
  if (!isNew && bookedAt && Math.abs((booking.createdAt?.getTime() || 0) - bookedAt.getTime()) > 60_000) {
    await Booking.collection.updateOne({ _id: booking._id }, { $set: { createdAt: bookedAt } });
  }
  return { outcome: isNew ? 'created' : 'updated', bookingId: booking._id };
}

/**
 * Re-read ONE appointment from Zenoti right now and reconcile it — the
 * panel's "Refresh from Zenoti" on a booking. Read-only towards Zenoti.
 */
async function refreshAppointment(bookingId) {
  const booking = await Booking.findById(bookingId);
  if (!booking) throw Object.assign(new Error('Booking not found'), { status: 404 });
  if (!booking.zenotiAppointmentId) throw Object.assign(new Error('This booking is not linked to a Zenoti appointment.'), { status: 400 });
  const detail = await zenoti.getAppointment(booking.zenotiAppointmentId);
  if (!detail) throw Object.assign(new Error('Zenoti has no appointment with this id any more.'), { status: 404 });
  const owner = await User.findById(booking.userId).select('_id fullName phone email zenotiGuestId zenotiCenterId').lean();
  const result = await upsertAppointment(detail, { user: owner, verified: true });
  return { result, booking: await Booking.findById(bookingId).populate('consultationId', 'name category price image').populate('userId', 'fullName email phone patientId') };
}

/** Backfill/update every appointment already fetched for one patient. */
async function syncUserAppointments(user, appointments) {
  if (!user || !Array.isArray(appointments) || !appointments.length) return { created: 0, updated: 0, skipped: 0, failed: 0 };
  const context = await lookupContext();
  const tally = { created: 0, updated: 0, skipped: 0, failed: 0 };
  for (const appointment of appointments) {
    try {
      const result = await upsertAppointment({
        ...appointment,
        centerId: appointment.centerId || user.zenotiCenterId,
        branchName: appointment.branchName || branchNameForCenter(appointment.centerId || user.zenotiCenterId),
      }, { user, context });
      tally[result.outcome] = (tally[result.outcome] || 0) + 1;
    } catch (error) {
      tally.failed += 1;
      logger.warn('Zenoti appointment backfill row failed', { appointmentId: appointment.id, error: error.message });
    }
  }
  return tally;
}

/**
 * Reconcile one clinic-date window for every live clinic. Zenoti caps the
 * appointments endpoint at seven days per call, so callers keep windows ≤7d.
 */
async function reconcileWindow(from, to, { trigger = 'schedule', mode = 'incremental' } = {}) {
  const tally = { total: 0, processed: 0, created: 0, updated: 0, skipped: 0, failed: 0 };
  let run = null;
  try {
    run = await ZenotiSyncRun.create({ type: 'appointments', trigger, mode });
    const context = await lookupContext();
    const clinics = Object.entries(CENTERS).filter(([, value]) => value.isClinic);
    const centerResults = await Promise.allSettled(clinics.map(([centerId]) =>
      zenoti.getCenterAppointments(centerId, { from, to, includeCancelled: true })
    ));
    const rows = [];
    const runStartedAt = new Date();
    const fulfilledCenters = [];
    centerResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        rows.push(...result.value);
        fulfilledCenters.push({ centerId: clinics[index][0], feedCount: result.value.length });
      } else {
        tally.failed += 1;
        logger.warn('Zenoti appointment center reconciliation failed', { center: clinics[index][1].name, error: result.reason?.message });
      }
    });
    tally.total = rows.length;
    await run.updateOne(tally);

    // Preload the entire linked-user index once. Calling provisionUserFromGuest
    // for every service row made a busy six-day diary too slow for a two-minute
    // cadence and aggravated legacy GUID-casing differences.
    const linked = await User.find({ zenotiGuestId: { $exists: true, $ne: null } })
      .select('_id fullName phone email zenotiGuestId zenotiCenterId source')
      .lean();
    const userByGuest = new Map(linked.map((owner) => [String(owner.zenotiGuestId).toLowerCase(), owner]));

    for (const appointment of rows) {
      try {
        const guestId = String(appointment.guest?.zenotiGuestId || '').toLowerCase();
        let owner = userByGuest.get(guestId) || null;
        if (!owner && appointment.guest) {
          owner = await provisionUserFromGuest(appointment.guest, { quiet: true });
          if (owner?.zenotiGuestId) userByGuest.set(String(owner.zenotiGuestId).toLowerCase(), owner);
        }
        const result = await upsertAppointment(appointment, { user: owner, context });
        tally.processed += 1;
        tally[result.outcome] = (tally[result.outcome] || 0) + 1;
      } catch (error) {
        tally.processed += 1;
        tally.failed += 1;
        logger.warn('Zenoti appointment reconciliation row failed', { appointmentId: appointment.id, error: error.message });
      }
      if (tally.processed % 50 === 0) await run.updateOne(tally);
    }

    // Rows that left the diary (deleted / moved in Zenoti).
    let retired = 0;
    for (const { centerId, feedCount } of fulfilledCenters) {
      const seenIds = new Set(rows.filter((r) => r.centerId === centerId).map((r) => String(r.id)));
      try {
        retired += await retireVanishedAppointments({ centerId, from, to, seenIds, runStartedAt, feedCount });
      } catch (error) {
        logger.warn('Zenoti vanished-appointment pass failed', { centerId, error: error.message });
      }
    }
    if (retired) logger.info('Zenoti: retired appointments no longer in the clinic diary', { from, to, retired });
    tally.retired = retired;
    await run.updateOne({ ...tally, status: 'completed', finishedAt: new Date() });
    return tally;
  } catch (error) {
    if (run) await run.updateOne({ ...tally, status: 'failed', error: error.message, finishedAt: new Date() });
    logger.error('Zenoti appointment reconciliation failed', { from, to, error: error.message });
    return tally;
  }
}

/**
 * The operational near window: yesterday through the next six days, every two
 * minutes. This is what keeps today's diary, check-ins and reception live.
 */
async function syncRecentAppointments({ trigger = 'schedule' } = {}) {
  if (!zenoti.isConfigured() || appointmentSyncRunning) return null;
  appointmentSyncRunning = true;
  try {
    const from = clinicDay(Date.now() - 24 * 60 * 60 * 1000);
    const to = clinicDay(Date.now() + 6 * 24 * 60 * 60 * 1000);
    return await reconcileWindow(from, to, { trigger, mode: 'incremental' });
  } finally {
    appointmentSyncRunning = false;
  }
}

/**
 * The booking-horizon window: day +6 through day +62, in seven-day chunks.
 *
 * The slot engine treats mirrored Zenoti appointments as ordinary Bookings, so
 * a Zenoti-side reservation only blocks an app slot once it has been mirrored.
 * The near window stops at six days out while the default dermatologist
 * booking horizon is 60 days — without this pass, a Zenoti booking ten days
 * ahead would leave its slot showing as free in the app. Runs on a slower
 * cadence (the far diary changes slowly) and never blocks the near window.
 */
let horizonSyncRunning = false;
async function syncUpcomingAppointments({ trigger = 'schedule' } = {}) {
  if (!zenoti.isConfigured() || horizonSyncRunning) return null;
  horizonSyncRunning = true;
  const totals = { total: 0, processed: 0, created: 0, updated: 0, skipped: 0, failed: 0 };
  try {
    for (let offset = 6; offset < 62; offset += 7) {
      const from = clinicDay(Date.now() + offset * 24 * 60 * 60 * 1000);
      const to = clinicDay(Date.now() + Math.min(offset + 7, 62) * 24 * 60 * 60 * 1000);
      const tally = await reconcileWindow(from, to, { trigger, mode: 'horizon' });
      if (tally) Object.keys(totals).forEach((k) => { totals[k] += tally[k] || 0; });
    }
    return totals;
  } finally {
    horizonSyncRunning = false;
  }
}

function isAppointmentSyncRunning() {
  return appointmentSyncRunning || horizonSyncRunning;
}

module.exports = {
  appointmentLocalParts,
  localStatus,
  mergeStatus,
  uniqueZenotiReference,
  // Exported so bulk backfills can build the lookup maps once instead of
  // rebuilding them (four collection reads) for every appointment row.
  lookupContext,
  upsertAppointment,
  refreshAppointment,
  appointmentAttended,
  syncUserAppointments,
  syncRecentAppointments,
  syncUpcomingAppointments,
  isAppointmentSyncRunning,
};
