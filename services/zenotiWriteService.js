/**
 * Zenoti write-back service (Phase 2).
 *
 * Pushes app-side activity INTO Zenoti so the CRM stays the source of truth:
 *   • a fresh app signup  → a Zenoti guest
 *   • an appointment booking (treatment / doctor consultation) → a Zenoti appointment
 *   • a product order → a Zenoti product invoice
 *
 * Design principles:
 *   • Best-effort & non-blocking — a CRM failure must NEVER break a user's
 *     signup, booking or order. Every entry point catches its own errors.
 *   • Idempotent — each record stores its Zenoti id; a second push is a no-op.
 *   • Gated by ZENOTI_WRITE_MODE:
 *        off     → do nothing
 *        dryrun  → resolve everything and LOG the exact payload, write nothing
 *                  (the safe default — proves the flow without touching prod)
 *        live    → perform the real Zenoti writes
 *
 * Flip to live only after validating against a disposable Zenoti record, per the
 * audit's required production controls.
 */

const zenoti = require('./zenotiService');
const {
  clinicCenterIdForBranch,
  normalizeIndianMobile,
  toZenotiGender,
} = require('../config/zenoti');
const logger = require('../utils/logger');

function clinicDay(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(value));
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/* ------------------------------- Mode gating ------------------------------- */
function mode() {
  return (process.env.ZENOTI_WRITE_MODE || 'dryrun').toLowerCase();
}
function isOff() {
  return mode() === 'off' || !zenoti.isConfigured();
}
function isLive() {
  return mode() === 'live' && zenoti.isConfigured();
}

/** Log a write we would/did perform. In dryrun we log the full payload. */
function logWrite(action, payload, extra = {}) {
  logger.info(`Zenoti write [${mode()}] ${action}`, {
    ...(mode() === 'dryrun' ? { payload } : {}),
    ...extra,
  });
}

/* ------------------------------- Resolvers -------------------------------- */
function parseJsonEnv(name) {
  try {
    return process.env[name] ? JSON.parse(process.env[name]) : {};
  } catch {
    logger.warn(`Ignoring malformed ${name} (not valid JSON)`);
    return {};
  }
}

const norm = (s) => String(s || '').trim().toLowerCase();

/**
 * Resolve one of our consultations to a Zenoti service id for a centre.
 * Order: explicit override map (by consultation id/slug/name) → code → name.
 */
async function resolveServiceId(centerId, consultation) {
  if (!consultation) return null;
  const overrides = parseJsonEnv('ZENOTI_SERVICE_MAP');
  const keys = [consultation._id?.toString(), consultation.slug, consultation.name].filter(Boolean);
  for (const k of keys) if (overrides[k]) return overrides[k];

  const services = await zenoti.getCenterServices(centerId).catch(() => []);
  if (!services.length) return null;
  const byCode = consultation.code && services.find((s) => norm(s.code) === norm(consultation.code));
  if (byCode) return byCode.id;
  const byName = services.find((s) => norm(s.name) === norm(consultation.name));
  return byName ? byName.id : null;
}

/** Resolve one of our products to a Zenoti product id for a centre. */
async function resolveProductId(centerId, product) {
  if (!product) return null;
  const overrides = parseJsonEnv('ZENOTI_PRODUCT_MAP');
  const keys = [product._id?.toString(), product.code, product.name].filter(Boolean);
  for (const k of keys) if (overrides[k]) return overrides[k];

  const products = await zenoti.getCenterProducts(centerId).catch(() => []);
  if (!products.length) return null;
  const byCode = product.code && products.find((p) => norm(p.code) === norm(product.code));
  if (byCode) return byCode.id;
  const byName = products.find((p) => norm(p.name) === norm(product.name));
  return byName ? byName.id : null;
}

/* ------------------------------- Guest push -------------------------------- */
/**
 * Ensure the given local user has a linked Zenoti guest, creating one if needed.
 * Idempotent: returns immediately if already linked; links (not duplicates) if a
 * guest with the same phone already exists in Zenoti.
 *
 * @returns {Promise<string|null>} the Zenoti guest id, or null (off/dryrun/failure).
 */
async function ensureGuest(user) {
  if (!user) return null;
  if (user.zenotiGuestId) return user.zenotiGuestId; // already linked
  if (isOff()) return null;

  const phone = normalizeIndianMobile(user.phone);
  const centerId = clinicCenterIdForBranch(user.location);

  // Never create a duplicate — a matching guest may already exist in Zenoti.
  try {
    const existing = phone ? await zenoti.findGuestByPhone(phone) : null;
    if (existing?.zenotiGuestId) {
      user.zenotiGuestId = existing.zenotiGuestId;
      user.zenotiCenterId = existing.centerId || centerId;
      user.zenotiSyncStatus = 'synced';
      user.zenotiSyncedAt = new Date();
      await user.save({ validateModifiedOnly: true });
      logger.info('Linked user to existing Zenoti guest', { userId: user._id });
      return user.zenotiGuestId;
    }
  } catch (err) {
    logger.warn('ensureGuest lookup failed', { userId: user._id, error: err.message });
  }

  const [firstName, ...rest] = String(user.fullName || 'Zennara Guest').trim().split(/\s+/);
  const payload = {
    center_id: centerId,
    personal_info: {
      first_name: firstName || 'Zennara',
      last_name: rest.join(' ') || 'Guest',
      email: user.email && !user.email.endsWith('@guest.zennara.in') ? user.email : undefined,
      // Zenoti's country_code is its internal country ID (India = 95), NOT the
      // +91 dialing code — that goes in phone_code. Verified against live guests.
      mobile_phone: phone ? { country_code: 95, phone_code: 91, number: phone } : undefined,
      gender: toZenotiGender(user.gender), // 0=Female, 1=Male, -1=None (2 is invalid)
      date_of_birth: user.dateOfBirth || undefined,
    },
  };

  // This Zenoti org makes a referral source MANDATORY for API-created guests
  // ("referral_source is mandatory"). The valid id comes from the org's config
  // (Zenoti portal → Admin/Setup → Referral Sources) and isn't exposed to this
  // API key. Set ZENOTI_REFERRAL_SOURCE_ID in .env and it's attached here.
  const referralSourceId = process.env.ZENOTI_REFERRAL_SOURCE_ID;
  if (referralSourceId) {
    payload.referral = { referral_source_id: referralSourceId };
  }

  logWrite('createGuest', payload, { userId: user._id });
  if (!isLive()) {
    user.zenotiSyncStatus = 'dryrun';
    await user.save({ validateModifiedOnly: true }).catch(() => {});
    return null;
  }

  try {
    const res = await zenoti.request('/v1/guests', { method: 'POST', body: payload });
    const guestId = res?.id || res?.Id || res?.guest?.id;
    if (!guestId) throw new Error('Zenoti guest create returned no id');
    user.zenotiGuestId = guestId;
    user.zenotiCenterId = centerId;
    user.zenotiSyncStatus = 'synced';
    user.zenotiSyncedAt = new Date();
    await user.save({ validateModifiedOnly: true });
    logger.info('Created Zenoti guest for user', { userId: user._id });
    return guestId;
  } catch (err) {
    user.zenotiSyncStatus = 'failed';
    user.zenotiSyncError = err.message;
    await user.save({ validateModifiedOnly: true }).catch(() => {});
    logger.error('Zenoti guest create failed', { userId: user._id, error: err.message });
    return null;
  }
}

/** Keep identity/contact edits made in Zennara reflected on the Zenoti guest. */
async function syncGuestProfile(userId) {
  const User = require('../models/User');
  const user = await User.findById(userId);
  if (!user || !user.zenotiGuestId || isOff()) return;
  if (!existingRecordWritebackEnabled()) {
    logger.info('Zenoti guest profile write-back disabled (ZENOTI_EDIT_EXISTING_WRITEBACK != true)', { userId });
    return;
  }
  try {
    const guest = await zenoti.getGuest(user.zenotiGuestId);
    const payload = guest?._raw;
    if (!payload) throw new Error('Zenoti guest profile could not be loaded for update.');
    const [firstName, ...rest] = String(user.fullName || '').trim().split(/\s+/);
    payload.personal_info = payload.personal_info || {};
    payload.personal_info.first_name = firstName || payload.personal_info.first_name;
    payload.personal_info.last_name = rest.join(' ') || payload.personal_info.last_name;
    if (user.email && !user.email.endsWith('@guest.zennara.in')) payload.personal_info.email = user.email;
    const phone = normalizeIndianMobile(user.phone);
    if (phone) payload.personal_info.mobile_phone = { country_code: 95, phone_code: 91, number: phone };
    if (user.gender) payload.personal_info.gender = toZenotiGender(user.gender);
    if (user.dateOfBirth) payload.personal_info.date_of_birth = user.dateOfBirth;

    logWrite('updateGuest', { guestId: user.zenotiGuestId, changedBy: 'Zennara' }, { userId: user._id });
    if (!isLive()) {
      user.zenotiSyncStatus = 'dryrun';
    } else {
      await zenoti.request(`/v1/guests/${user.zenotiGuestId}`, { method: 'PUT', body: payload });
      user.zenotiSyncStatus = 'synced';
      user.zenotiSyncError = null;
      user.zenotiSyncedAt = new Date();
    }
    user.$locals.skipZenotiWrite = true;
    await user.save({ validateModifiedOnly: true });
  } catch (error) {
    user.zenotiSyncStatus = 'failed';
    user.zenotiSyncError = error.message;
    user.$locals.skipZenotiWrite = true;
    await user.save({ validateModifiedOnly: true }).catch(() => {});
    logger.error('Zenoti guest profile update failed', { userId, error: error.message });
  }
}

function clinicalNoteText(note, booking) {
  const lines = [
    `Zennara clinical record${booking?.referenceNumber ? ` (${booking.referenceNumber})` : ''}`,
    note.complaint ? `Complaint: ${note.complaint}` : null,
    note.examination ? `Examination: ${note.examination}` : null,
    note.assessment ? `Assessment: ${note.assessment}` : null,
    note.plan ? `Plan: ${note.plan}` : null,
    Array.isArray(note.prescription) && note.prescription.length
      ? `Prescription: ${note.prescription.map((item) => [item.medicine, item.dosage, item.frequency, item.duration, item.instructions].filter(Boolean).join(' · ')).join('; ')}`
      : null,
    note.followUpDate ? `Follow-up: ${clinicDay(note.followUpDate)}` : null,
    note.doctorName ? `Doctor: ${note.doctorName}` : null,
  ];
  return lines.filter(Boolean).join('\n');
}

/** Push the app/admin clinical note + prescription into Zenoti guest history. */
async function syncConsultationNote(noteId) {
  const ConsultationNote = require('../models/ConsultationNote');
  const Booking = require('../models/Booking');
  const User = require('../models/User');
  const note = await ConsultationNote.findById(noteId);
  if (!note || isOff()) return;
  if (note.zenotiNoteId && !existingRecordWritebackEnabled()) {
    logger.info('Zenoti note update write-back disabled (ZENOTI_EDIT_EXISTING_WRITEBACK != true)', { noteId });
    return;
  }
  try {
    const [booking, user] = await Promise.all([
      Booking.findById(note.bookingId).select('referenceNumber preferredLocation zenotiAppointmentId'),
      User.findById(note.userId).select('zenotiGuestId zenotiCenterId'),
    ]);
    if (!user?.zenotiGuestId) throw new Error('Patient is not linked to a Zenoti guest.');
    const centerId = user.zenotiCenterId || clinicCenterIdForBranch(booking?.preferredLocation);
    const centerName = require('../config/zenoti').centerById(centerId)?.name || booking?.preferredLocation || '';
    const payload = {
      ...(note.zenotiNoteId ? { id: note.zenotiNoteId } : {}),
      alert: false,
      center: { id: centerId, name: centerName },
      entity_name: 'ZennaraClinicalRecord',
      entity_pk: 0,
      is_private: false,
      note_type: 2,
      notes: clinicalNoteText(note, booking),
      ...(process.env.ZENOTI_UPDATED_BY_ID ? { added_by: { id: process.env.ZENOTI_UPDATED_BY_ID, name: 'Zennara' } } : {}),
    };
    // Clinical content must never be copied into application logs, even in
    // dry-run mode. Log only routing metadata; the API request still receives
    // the complete encrypted-in-transit payload in live mode.
    logWrite(note.zenotiNoteId ? 'updateClinicalNote' : 'createClinicalNote', {
      guestId: user.zenotiGuestId,
      noteType: payload.note_type,
      characterCount: payload.notes.length,
    }, { noteId: note._id });
    if (!isLive()) {
      note.zenotiSyncStatus = 'dryrun';
    } else {
      const result = await zenoti.request(
        note.zenotiNoteId
          ? `/v1/guests/${user.zenotiGuestId}/notes/${note.zenotiNoteId}`
          : `/v1/guests/${user.zenotiGuestId}/notes`,
        { method: note.zenotiNoteId ? 'PUT' : 'POST', body: payload }
      );
      note.zenotiNoteId = note.zenotiNoteId || result?.id || null;
      note.zenotiSyncStatus = 'synced';
      note.zenotiSyncError = null;
      note.zenotiSyncedAt = new Date();
    }
    note.$locals.skipZenotiWrite = true;
    await note.save({ validateModifiedOnly: true });
  } catch (error) {
    note.zenotiSyncStatus = 'failed';
    note.zenotiSyncError = error.message;
    note.$locals.skipZenotiWrite = true;
    await note.save({ validateModifiedOnly: true }).catch(() => {});
    logger.error('Zenoti clinical note sync failed', { noteId, error: error.message });
  }
}

/** Create the Zenoti membership-sale invoice for an in-app Zen upgrade. */
async function syncMembership(userId) {
  const User = require('../models/User');
  const user = await User.findById(userId);
  if (!user || user.memberType !== 'Zen Member' || user.zenotiMembershipInvoiceId || isOff()) return;
  try {
    const guestId = await ensureGuest(user);
    const membershipVersionIds = process.env.ZENOTI_MEMBERSHIP_VERSION_IDS || process.env.ZENOTI_MEMBERSHIP_ID;
    const payload = {
      center_id: user.zenotiCenterId || clinicCenterIdForBranch(user.location),
      user_id: guestId,
      membership_version_ids: membershipVersionIds,
    };
    if (!guestId || !membershipVersionIds) {
      user.zenotiMembershipSyncStatus = isLive() ? 'skipped' : 'dryrun';
      user.zenotiMembershipSyncError = `unresolved: ${!guestId ? 'guestId' : 'ZENOTI_MEMBERSHIP_VERSION_IDS'}`;
    } else if (!isLive()) {
      user.zenotiMembershipSyncStatus = 'dryrun';
      user.zenotiMembershipSyncError = null;
      logWrite('createMembershipInvoice', payload, { userId: user._id });
    } else {
      const result = await zenoti.request('/api/Catalog/Memberships/CreateInvoice', { method: 'POST', body: payload });
      user.zenotiMembershipInvoiceId = result?.invoice_id || result?.id || result?.Invoice?.Id || result?.Invoice?.id || null;
      if (!user.zenotiMembershipInvoiceId) throw new Error('Zenoti membership invoice returned no id.');
      user.zenotiMembershipSyncStatus = 'synced';
      user.zenotiMembershipSyncError = null;
    }
    user.$locals.skipZenotiWrite = true;
    await user.save({ validateModifiedOnly: true });
  } catch (error) {
    user.zenotiMembershipSyncStatus = 'failed';
    user.zenotiMembershipSyncError = error.message;
    user.$locals.skipZenotiWrite = true;
    await user.save({ validateModifiedOnly: true }).catch(() => {});
    logger.error('Zenoti membership invoice sync failed', { userId, error: error.message });
  }
}

/** Create a Zenoti series-package sale invoice for a local package assignment. */
async function syncPackageAssignment(assignmentId) {
  const PackageAssignment = require('../models/PackageAssignment');
  const User = require('../models/User');
  const assignment = await PackageAssignment.findById(assignmentId);
  if (!assignment || assignment.zenotiInvoiceId || isOff()) return;
  try {
    const user = await User.findById(assignment.userId);
    const guestId = await ensureGuest(user);
    const packageMap = parseJsonEnv('ZENOTI_PACKAGE_MAP');
    const packageId = packageMap[String(assignment.packageId)] || packageMap[assignment.packageDetails?.packageName] || null;
    const payload = {
      guest_id: guestId,
      center_id: user?.zenotiCenterId || clinicCenterIdForBranch(assignment.preferredLocation || user?.location),
      notes: `Zennara package ${assignment.assignmentId}`,
      package_details: packageId ? [{ id: packageId }] : [],
    };
    assignment.zenotiPackageId = packageId;
    if (!guestId || !packageId) {
      assignment.zenotiSyncStatus = isLive() ? 'skipped' : 'dryrun';
      assignment.zenotiSyncError = `unresolved: ${!guestId ? 'guestId' : 'ZENOTI_PACKAGE_MAP'}`;
    } else if (!isLive()) {
      assignment.zenotiSyncStatus = 'dryrun';
      assignment.zenotiSyncError = null;
      logWrite('createPackageInvoice', payload, { assignmentId: assignment._id });
    } else {
      const result = await zenoti.request('/v1/invoices/packages', { method: 'POST', body: payload });
      assignment.zenotiInvoiceId = result?.invoice_id || result?.id || result?.invoice?.id || result?.Invoice?.Id || null;
      if (!assignment.zenotiInvoiceId) throw new Error('Zenoti package invoice returned no id.');
      assignment.zenotiSyncStatus = 'synced';
      assignment.zenotiSyncError = null;
      assignment.zenotiSyncedAt = new Date();
    }
    assignment.$locals.skipZenotiWrite = true;
    await assignment.save({ validateModifiedOnly: true });
  } catch (error) {
    assignment.zenotiSyncStatus = 'failed';
    assignment.zenotiSyncError = error.message;
    assignment.$locals.skipZenotiWrite = true;
    await assignment.save({ validateModifiedOnly: true }).catch(() => {});
    logger.error('Zenoti package invoice sync failed', { assignmentId, error: error.message });
  }
}

/* ---------------------------- Appointment push ----------------------------- */
/**
 * Push a booking to Zenoti as an appointment. Idempotent via booking.zenotiAppointmentId.
 * The whole thing is best-effort — it updates the booking's sync status and
 * never throws to its caller.
 */
async function syncBooking(bookingId) {
  const Booking = require('../models/Booking');
  const Consultation = require('../models/Consultation');
  const User = require('../models/User');

  const booking = await Booking.findById(bookingId);
  if (!booking) return;
  if (booking.zenotiAppointmentId) return; // already synced
  if (isOff()) return;

  try {
    const user = await User.findById(booking.userId);
    const guestId = await ensureGuest(user);
    const centerId = clinicCenterIdForBranch(booking.preferredLocation);
    const consultation = booking.consultationId
      ? await Consultation.findById(booking.consultationId).lean()
      : null;
    const serviceId = await resolveServiceId(centerId, consultation);

    // Prefer the confirmed date/time, else the requested one.
    const date = clinicDay(booking.confirmedDate || booking.preferredDate || new Date());

    const payload = {
      center_id: centerId,
      date,
      is_only_catalog_employees: false,
      guests: [
        {
          id: guestId,
          items: [{ item: { id: serviceId } }],
        },
      ],
      notes: `Zennara app booking ${booking.referenceNumber || booking._id}`,
    };

    // Can't proceed without a guest + service mapping.
    const missing = [];
    if (!guestId) missing.push('guestId');
    if (!serviceId) missing.push('serviceId');
    if (missing.length) {
      booking.zenotiSyncStatus = isLive() ? 'skipped' : 'dryrun';
      booking.zenotiSyncError = `unresolved: ${missing.join(', ')}`;
      await booking.save({ validateModifiedOnly: true }).catch(() => {});
      logWrite('bookAppointment(skipped)', payload, { bookingId: booking._id, missing });
      return;
    }

    logWrite('bookAppointment', payload, { bookingId: booking._id });
    if (!isLive()) {
      booking.zenotiSyncStatus = 'dryrun';
      await booking.save({ validateModifiedOnly: true }).catch(() => {});
      return;
    }

    // Zenoti booking flow: create booking → get slots → reserve → confirm.
    const created = await zenoti.request('/v1/bookings', { method: 'POST', body: payload });
    const zBookingId = created?.id || created?.Id;
    if (!zBookingId) throw new Error('Zenoti booking create returned no id');

    const slotsRes = await zenoti.request(`/v1/bookings/${zBookingId}/slots`, { method: 'GET' });
    const slots = slotsRes?.slots || slotsRes?.Slots || [];
    const wantedTime = booking.confirmedTime || booking.slotTime || booking.preferredTimeSlots?.[0] || null;
    const slotValue = (slot) => slot && (slot.Time || slot.time || slot.slot_time || slot.start_time);
    const slotTime = wantedTime
      ? slotValue(slots.find((slot) => String(slotValue(slot) || '').includes(`T${wantedTime}`)))
      : slotValue(slots[0]);
    if (!slotTime) {
      throw new Error(wantedTime
        ? `Requested Zenoti slot ${wantedTime} is unavailable on ${date}`
        : `Zenoti returned no available slot on ${date}`);
    }

    await zenoti.request(`/v1/bookings/${zBookingId}/slots/reserve`, {
      method: 'POST',
      body: { slot_time: slotTime },
    });
    const confirmed = await zenoti.request(`/v1/bookings/${zBookingId}/slots/confirm`, {
      method: 'POST',
      body: { notes: payload.notes },
    });

    const invoice = confirmed?.invoice || confirmed?.Invoice || {};
    const item = (invoice.items || invoice.Items || [])[0] || {};
    booking.zenotiAppointmentId =
      item.appointment_id || item.AppointmentId || confirmed?.appointment_id || zBookingId;
    booking.zenotiInvoiceId = invoice.invoice_id || invoice.id || confirmed?.invoice_id || null;
    booking.zenotiInvoiceItemId = item.invoice_item_id || item.InvoiceItemId || null;
    booking.zenotiAppointmentGroupId =
      confirmed?.appointment_group_id || invoice.appointment_group_id || invoice.AppointmentGroupId || null;
    booking.zenotiServiceId = serviceId;
    booking.zenotiSyncStatus = 'synced';
    booking.zenotiSyncedAt = new Date();
    booking.zenotiSyncError = null;
    await booking.save({ validateModifiedOnly: true });
    logger.info('Pushed booking to Zenoti', { bookingId: booking._id });
  } catch (err) {
    booking.zenotiSyncStatus = 'failed';
    booking.zenotiSyncError = err.message;
    await booking.save({ validateModifiedOnly: true }).catch(() => {});
    logger.error('Zenoti syncBooking failed', { bookingId, error: err.message });
  }
}

/** Resolve identifiers missing on records created by the older write parser. */
async function hydrateAppointmentIds(booking) {
  if (!booking.zenotiAppointmentId) return;
  try {
    const detail = await zenoti.request(`/v1/appointments/${booking.zenotiAppointmentId}`);
    booking.zenotiInvoiceId = booking.zenotiInvoiceId || detail?.invoice_id || null;
    booking.zenotiInvoiceItemId = booking.zenotiInvoiceItemId || detail?.invoice_item_id || null;
    booking.zenotiAppointmentGroupId = booking.zenotiAppointmentGroupId || detail?.appointment_group_id || null;
    booking.zenotiAppointmentSegmentId = booking.zenotiAppointmentSegmentId || detail?.appointment_segment_id || null;
    booking.zenotiServiceId = booking.zenotiServiceId || detail?.service?.id || null;
  } catch (_) {
    // The old field sometimes contains an invoice id, not an appointment id;
    // callers can still use that value as the invoice fallback below.
  }
}

function bookingDateAndTime(booking) {
  const date = clinicDay(booking.confirmedDate || booking.preferredDate || new Date());
  const time = booking.confirmedTime || booking.slotTime || booking.preferredTimeSlots?.[0] || null;
  return { date, time };
}

async function reserveExactSlot(bookingId, date, time) {
  const slotsRes = await zenoti.request(`/v1/bookings/${bookingId}/slots`, { method: 'GET' });
  const slots = slotsRes?.slots || slotsRes?.Slots || [];
  const valueOf = (slot) => slot && (slot.Time || slot.time || slot.slot_time || slot.start_time);
  const chosen = time
    ? valueOf(slots.find((slot) => String(valueOf(slot) || '').includes(`T${time}`)))
    : valueOf(slots[0]);
  if (!chosen) throw new Error(`Requested Zenoti slot ${time || ''} is unavailable on ${date}`.trim());
  await zenoti.request(`/v1/bookings/${bookingId}/slots/reserve`, { method: 'POST', body: { slot_time: chosen } });
  return zenoti.request(`/v1/bookings/${bookingId}/slots/confirm`, { method: 'POST', body: {} });
}

/** Reschedule using Zenoti's documented create → reserve → confirm workflow. */
async function rescheduleLinkedBooking(booking, user) {
  const { date, time } = bookingDateAndTime(booking);
  if (!booking.zenotiInvoiceId || !booking.zenotiInvoiceItemId || !booking.zenotiServiceId) {
    throw new Error('Zenoti reschedule identifiers are incomplete; wait for the next inbound reconciliation and retry.');
  }
  const payload = {
    center_id: clinicCenterIdForBranch(booking.preferredLocation),
    date,
    is_only_catalog_employees: false,
    guests: [{
      id: user.zenotiGuestId,
      invoice_id: booking.zenotiInvoiceId,
      items: [{
        item: { id: booking.zenotiServiceId },
        invoice_item_id: booking.zenotiInvoiceItemId,
      }],
    }],
  };
  logWrite('rescheduleAppointment', payload, { bookingId: booking._id });
  const created = await zenoti.request('/v1/bookings', { method: 'POST', body: payload });
  const zBookingId = created?.id || created?.Id;
  if (!zBookingId) throw new Error('Zenoti reschedule returned no booking id');
  const confirmed = await reserveExactSlot(zBookingId, date, time);
  const invoice = confirmed?.invoice || confirmed?.Invoice || {};
  const item = (invoice.items || invoice.Items || [])[0] || {};
  booking.zenotiAppointmentId = item.appointment_id || booking.zenotiAppointmentId;
  booking.zenotiInvoiceId = invoice.invoice_id || booking.zenotiInvoiceId;
  booking.zenotiInvoiceItemId = item.invoice_item_id || booking.zenotiInvoiceItemId;
  booking.zenotiAppointmentGroupId = confirmed?.appointment_group_id || invoice.appointment_group_id || booking.zenotiAppointmentGroupId;
}

/**
 * Push a linked booking's lifecycle changes back to Zenoti. Creation is handled
 * by syncBooking; this covers confirm, reschedule, check-in/start, completion,
 * cancellation and no-show.
 */
/**
 * Lifecycle write-back (confirm / check-in / complete / cancel / no-show /
 * reschedule) is a separate switch from record creation. It is OFF unless
 * ZENOTI_LIFECYCLE_WRITEBACK=true, and it NEVER applies to an appointment that
 * was booked in Zenoti (source 'zenoti'): the clinic's own diary is the system
 * of record for those, and mirrored rows must never write their state back.
 *
 * Why: on 2026-09-02/03 the automatic no-show job marked hundreds of mirrored
 * clinic appointments No Show and this function recorded every one of them in
 * Zenoti. See Technical Documentation/ZENOTI-NO-SHOW-INCIDENT-2026-09-03.md.
 */
function lifecycleWritebackEnabled() {
  return String(process.env.ZENOTI_LIFECYCLE_WRITEBACK || 'false').toLowerCase() === 'true';
}
/**
 * Editing an EXISTING Zenoti record (guest profile, an existing note) is a
 * second opt-in, separate from creating new records. Default off: a wrong
 * field in a PUT overwrites what the clinic entered.
 */
function existingRecordWritebackEnabled() {
  return String(process.env.ZENOTI_EDIT_EXISTING_WRITEBACK || 'false').toLowerCase() === 'true';
}

async function syncBookingState(bookingId) {
  const Booking = require('../models/Booking');
  const User = require('../models/User');
  const booking = await Booking.findById(bookingId);
  if (!booking || isOff() || (!booking.zenotiAppointmentId && !booking.zenotiInvoiceId)) return;
  if (booking.source === 'zenoti') {
    logger.info('Zenoti lifecycle write-back refused for a Zenoti-owned appointment', { bookingId, status: booking.status });
    return;
  }
  if (!lifecycleWritebackEnabled()) {
    logger.info('Zenoti lifecycle write-back disabled (ZENOTI_LIFECYCLE_WRITEBACK != true)', { bookingId, status: booking.status });
    return;
  }

  try {
    await hydrateAppointmentIds(booking);
    const user = await User.findById(booking.userId).select('zenotiGuestId');
    const updatedById = process.env.ZENOTI_UPDATED_BY_ID;
    const invoiceId = booking.zenotiInvoiceId || booking.zenotiAppointmentId;
    const groupId = booking.zenotiAppointmentGroupId;
    const action = `bookingState:${booking.status}`;
    logWrite(action, { bookingId: booking._id, invoiceId, groupId });

    if (!isLive()) {
      booking.zenotiSyncStatus = 'dryrun';
      booking.zenotiSyncError = null;
    } else if (booking.status === 'Cancelled') {
      if (!invoiceId) throw new Error('Zenoti invoice id is required to cancel this booking.');
      await zenoti.request(`/v1/invoices/${invoiceId}/cancel`, {
        method: 'PUT',
        query: { comments: booking.cancellationReason || 'Cancelled from Zennara' },
      });
      booking.zenotiSyncStatus = 'synced';
    } else if (booking.status === 'No Show') {
      if (!groupId) throw new Error('Zenoti appointment group id is required to mark no-show.');
      await zenoti.request(`/v1/appointments/${groupId}/no_show`, {
        method: 'PUT', body: { comments: booking.cancellationReason || 'No show recorded in Zennara' },
      });
      booking.zenotiSyncStatus = 'synced';
    } else if (booking.status === 'In Progress') {
      if (!groupId) throw new Error('Zenoti appointment group id is required to check in.');
      await zenoti.request(`/v1/appointments/${groupId}/check_in`, { method: 'PUT' });
      if (updatedById && booking.zenotiAppointmentId) {
        await zenoti.request(`/v1/appointments/${booking.zenotiAppointmentId}/progress`, {
          method: 'PUT', body: { updated_by_id: updatedById, progress: 1, ...(booking.zenotiAppointmentSegmentId ? { appointment_segment_id: booking.zenotiAppointmentSegmentId } : {}) },
        });
      }
      booking.zenotiSyncStatus = 'synced';
    } else if (booking.status === 'Completed') {
      if (!updatedById) throw new Error('ZENOTI_UPDATED_BY_ID is required to complete appointments in Zenoti.');
      await zenoti.request(`/v1/appointments/${booking.zenotiAppointmentId}/progress`, {
        method: 'PUT', body: { updated_by_id: updatedById, progress: 2, ...(booking.zenotiAppointmentSegmentId ? { appointment_segment_id: booking.zenotiAppointmentSegmentId } : {}) },
      });
      booking.zenotiSyncStatus = 'synced';
    } else if (booking.status === 'Rescheduled') {
      if (!user?.zenotiGuestId) throw new Error('Booking owner is not linked to a Zenoti guest.');
      await rescheduleLinkedBooking(booking, user);
      booking.zenotiSyncStatus = 'synced';
    } else if (booking.status === 'Confirmed') {
      if (!invoiceId || !updatedById) throw new Error('Zenoti invoice id and ZENOTI_UPDATED_BY_ID are required to confirm appointments.');
      await zenoti.request(`/v1/invoices/${invoiceId}/confirm`, {
        method: 'PUT', body: { updated_by_id: updatedById },
      });
      booking.zenotiSyncStatus = 'synced';
    } else {
      booking.zenotiSyncStatus = 'skipped';
      booking.zenotiSyncError = `No Zenoti lifecycle action for ${booking.status}`;
    }

    if (booking.zenotiSyncStatus === 'synced') booking.zenotiSyncError = null;
    booking.zenotiSyncedAt = new Date();
    booking.$locals.skipZenotiWrite = true;
    await booking.save({ validateModifiedOnly: true });
  } catch (error) {
    booking.zenotiSyncStatus = 'failed';
    booking.zenotiSyncError = error.message;
    booking.$locals.skipZenotiWrite = true;
    await booking.save({ validateModifiedOnly: true }).catch(() => {});
    logger.error('Zenoti syncBookingState failed', { bookingId, error: error.message });
  }
}

/* ------------------------------- Order push -------------------------------- */
/**
 * Push a product order to Zenoti as a product invoice. Idempotent via
 * order.zenotiInvoiceId. Best-effort; never throws to its caller.
 *
 * Note: this records the sale (invoice + items). It does not push payment/tender
 * — money reconciliation stays out of scope here on purpose.
 */
async function syncOrder(orderId) {
  const ProductOrder = require('../models/ProductOrder');
  const Product = require('../models/Product');
  const User = require('../models/User');

  const order = await ProductOrder.findById(orderId);
  if (!order) return;
  if (order.zenotiInvoiceId) return;
  if (isOff()) return;

  try {
    const user = await User.findById(order.userId);
    const guestId = await ensureGuest(user);
    const centerId = clinicCenterIdForBranch(user?.location);

    // Resolve each line item to a Zenoti product id.
    const productIds = await Promise.all(
      (order.items || []).map(async (it) => {
        const product = it.productId ? await Product.findById(it.productId).lean() : null;
        const id = await resolveProductId(centerId, product);
        return { id, quantity: it.quantity || 1, name: product?.name || it.productName };
      })
    );
    const resolved = productIds.filter((p) => p.id);

    const payload = {
      center_id: centerId,
      guest_id: guestId,
      items: resolved.map((p) => ({ product_id: p.id, quantity: p.quantity })),
      notes: `Zennara app order ${order.orderNumber || order._id}`,
    };

    const missing = [];
    if (!guestId) missing.push('guestId');
    if (!resolved.length) missing.push('productIds');
    if (missing.length) {
      order.zenotiSyncStatus = isLive() ? 'skipped' : 'dryrun';
      order.zenotiSyncError = `unresolved: ${missing.join(', ')}`;
      await order.save({ validateModifiedOnly: true }).catch(() => {});
      logWrite('createInvoice(skipped)', payload, { orderId: order._id, missing });
      return;
    }

    logWrite('createInvoice', payload, { orderId: order._id });
    if (!isLive()) {
      order.zenotiSyncStatus = 'dryrun';
      await order.save({ validateModifiedOnly: true }).catch(() => {});
      return;
    }

    // Create a product sale invoice for the guest.
    const res = await zenoti.request('/v1/invoices/products', { method: 'POST', body: payload });
    const invoiceId = res?.invoice_id || res?.id || res?.Id;
    if (!invoiceId) throw new Error('Zenoti product invoice returned no id');

    order.zenotiInvoiceId = invoiceId;
    order.zenotiSyncStatus = 'synced';
    order.zenotiSyncedAt = new Date();
    order.zenotiSyncError = null;
    await order.save({ validateModifiedOnly: true });
    logger.info('Pushed order to Zenoti', { orderId: order._id });
  } catch (err) {
    order.zenotiSyncStatus = 'failed';
    order.zenotiSyncError = err.message;
    await order.save({ validateModifiedOnly: true }).catch(() => {});
    logger.error('Zenoti syncOrder failed', { orderId, error: err.message });
  }
}

module.exports = {
  mode,
  isOff,
  isLive,
  lifecycleWritebackEnabled,
  existingRecordWritebackEnabled,
  ensureGuest,
  syncGuestProfile,
  syncConsultationNote,
  syncMembership,
  syncPackageAssignment,
  syncBooking,
  syncBookingState,
  syncOrder,
  resolveServiceId,
  resolveProductId,
};
