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
const { provisionUserFromGuest } = require('./zenotiSyncService');
const { CENTERS, branchNameForCenter } = require('../config/zenoti');
const Doctor = require('../models/Doctor');
const { buildDoctorMatcher, tierTitle } = require('../utils/dermatologistMatch');
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

function localParts(value) {
  const raw = String(value || '');
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (!match) return { date: new Date(value), day: null, time: null };
  return {
    date: new Date(`${match[1]}T00:00:00+05:30`),
    day: match[1],
    time: match[2],
  };
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

async function lookupContext() {
  const [consultations, branches, doctors] = await Promise.all([
    Consultation.find({}).select('_id name slug').lean(),
    Branch.find({}).select('_id name').lean(),
    Doctor.find({}).select('doctorId name tier').lean(),
  ]);
  const consultationByName = new Map(consultations.map((c) => [norm(c.name), c]));
  const branchByName = new Map(branches.map((b) => [norm(b.name), b]));
  return { consultationByName, branchByName, matchDoctor: buildDoctorMatcher(doctors) };
}

function amountOf(appointment) {
  const n = Number(appointment.price);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Upsert one normalised Zenoti appointment. `user` may be supplied for the
 * guest-history backfill; center polling provisions it from appointment.guest.
 */
async function upsertAppointment(appointment, { user = null, context = null } = {}) {
  if (!appointment?.id) return { outcome: 'skipped', reason: 'missing appointment id' };
  const guest = appointment.guest;
  const owner = user || (guest ? await provisionUserFromGuest(guest, { quiet: true }) : null);
  if (!owner) return { outcome: 'skipped', reason: 'missing guest' };

  const ctx = context || await lookupContext();
  const branchName = appointment.branchName || branchNameForCenter(appointment.centerId || owner.zenotiCenterId);
  const branch = ctx.branchByName.get(norm(branchName));
  const consultation = ctx.consultationByName.get(norm(appointment.serviceName));
  const parts = localParts(appointment.startTime);
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
    });
  }
  const isNew = !booking;
  if (!booking) {
    booking = new Booking({
      userId: owner._id,
      source: 'zenoti',
      // The generic four-digit random reference collides during bulk history
      // imports. Zenoti's GUID gives this row a stable, globally unique ref.
      referenceNumber: `ZNT${String(appointment.id).replace(/-/g, '').slice(0, 20).toUpperCase()}`,
    });
  }

  const status = localStatus(appointment);
  booking.userId = owner._id;
  if (consultation) booking.consultationId = consultation._id;
  booking.fullName = owner.fullName || guest?.fullName || 'Zennara Guest';
  booking.mobileNumber = owner.phone || guest?.phone || '';
  booking.email = owner.email || guest?.email || '';
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
  booking.paymentMethod = booking.paymentMethod || 'Other';
  // Zenoti files the dermatologist under `therapist`; attribute to our roster.
  const derm = ctx.matchDoctor ? ctx.matchDoctor(appointment.therapistName) : null;
  if (derm) {
    booking.specialistId = derm.doctorId;
    booking.specialistName = derm.name;
    booking.specialistTier = tierTitle(derm);
  } else if (appointment.therapistName) {
    // Not on our roster: still show the practitioner's name rather than "Unassigned".
    booking.therapistName = appointment.therapistName;
    if (!booking.specialistId && !booking.specialistName) booking.specialistName = appointment.therapistName.replace(/^dr\.?\s*/i, 'Dr ');
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
  };
  booking.zenotiSyncStatus = 'synced';
  booking.zenotiSyncError = null;
  booking.zenotiSyncedAt = new Date();
  booking.zenotiLastInboundAt = new Date();
  if (appointment.notes && !booking.notes) booking.notes = appointment.notes;

  // Mark the document so Booking's outbound post-save hook does not echo the
  // imported lifecycle state back to Zenoti.
  booking.$locals.skipZenotiWrite = true;
  await booking.save({ validateModifiedOnly: !isNew });
  return { outcome: isNew ? 'created' : 'updated', bookingId: booking._id };
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
 * Reconcile yesterday through the next five days for every live clinic. Zenoti
 * caps this endpoint at seven days, and the scheduler calls it every 2 minutes.
 */
async function syncRecentAppointments({ trigger = 'schedule' } = {}) {
  if (!zenoti.isConfigured() || appointmentSyncRunning) return null;
  appointmentSyncRunning = true;
  const tally = { total: 0, processed: 0, created: 0, updated: 0, skipped: 0, failed: 0 };
  let run = null;
  try {
    run = await ZenotiSyncRun.create({ type: 'appointments', trigger, mode: 'incremental' });
    const context = await lookupContext();
    const from = clinicDay(Date.now() - 24 * 60 * 60 * 1000);
    const to = clinicDay(Date.now() + 6 * 24 * 60 * 60 * 1000);
    const clinics = Object.entries(CENTERS).filter(([, value]) => value.isClinic);
    const centerResults = await Promise.allSettled(clinics.map(([centerId]) =>
      zenoti.getCenterAppointments(centerId, { from, to, includeCancelled: true })
    ));
    const rows = [];
    centerResults.forEach((result, index) => {
      if (result.status === 'fulfilled') rows.push(...result.value);
      else {
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
    await run.updateOne({ ...tally, status: 'completed', finishedAt: new Date() });
    return tally;
  } catch (error) {
    if (run) await run.updateOne({ ...tally, status: 'failed', error: error.message, finishedAt: new Date() });
    logger.error('Zenoti appointment reconciliation failed', { error: error.message });
    return tally;
  } finally {
    appointmentSyncRunning = false;
  }
}

function isAppointmentSyncRunning() {
  return appointmentSyncRunning;
}

module.exports = {
  localStatus,
  upsertAppointment,
  syncUserAppointments,
  syncRecentAppointments,
  isAppointmentSyncRunning,
};
