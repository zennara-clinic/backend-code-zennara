/**
 * Zenoti write-back service.
 *
 * Pushes app-side activity INTO Zenoti so the CRM stays the source of truth:
 *   • a fresh app signup  → a Zenoti guest
 *   • an appointment booking (treatment / doctor consultation) → a Zenoti appointment
 *   • a product order → a Zenoti product invoice
 *
 * Design principles:
 *   • Confirmed appointment state is blocking — the app cannot say Confirmed
 *     until Zenoti has created, reserved, and confirmed the appointment.
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
  CENTERS,
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

/* ---------------------------- Safety breaker ------------------------------ *
 * Every LIVE write to Zenoti passes through liveWrite(). If more than a small
 * number happen in a short window the breaker trips and every further write is
 * refused (and recorded as 'skipped' on the record) until an admin resets it or
 * the server restarts. A legitimate day at the clinic produces a handful of
 * app bookings/orders; hundreds of writes in minutes is a bug, not business —
 * exactly the shape of the 2026-09-03 no-show incident.
 * ------------------------------------------------------------------------- */
// One appointment consumes three Zenoti writes (create, reserve, confirm), and
// a new guest consumes a fourth. The old 15/15-minute default tripped after
// only three or four legitimate bookings. These limits still stop a runaway
// bulk job long before the historical hundreds-of-writes incident.
const LIMIT_15_MIN = Math.max(1, Number(process.env.ZENOTI_WRITE_LIMIT_15MIN) || 120);
const LIMIT_1_HOUR = Math.max(LIMIT_15_MIN, Number(process.env.ZENOTI_WRITE_LIMIT_HOUR) || 300);
const writeTimes = [];
const breaker = { tripped: false, at: null, reason: null, lastAction: null };

function pruneWrites(now = Date.now()) {
  while (writeTimes.length && now - writeTimes[0] > 60 * 60 * 1000) writeTimes.shift();
}
function breakerStatus() {
  const now = Date.now();
  pruneWrites(now);
  return {
    ...breaker,
    writesLast15Min: writeTimes.filter((t) => now - t <= 15 * 60 * 1000).length,
    writesLastHour: writeTimes.length,
    limit15Min: LIMIT_15_MIN,
    limitHour: LIMIT_1_HOUR,
  };
}
function resetBreaker() {
  breaker.tripped = false; breaker.at = null; breaker.reason = null;
  writeTimes.length = 0;
  logger.warn('Zenoti write breaker reset by admin');
}
/** Run one live Zenoti write under the breaker. */
const BULK_LIMIT_1_HOUR = Math.max(LIMIT_1_HOUR, Number(process.env.ZENOTI_BULK_WRITE_LIMIT_HOUR) || 600);
const bulkWriteTimes = [];
async function liveWrite(action, fn, { bulk = false } = {}) {
  const now = Date.now();
  pruneWrites(now);
  if (breaker.tripped) {
    throw new Error(`Zenoti write-back paused by safety breaker since ${breaker.at?.toISOString?.() || breaker.at}: ${breaker.reason}`);
  }
  if (bulk) {
    // Roster publishing legitimately writes hundreds of small shift records in
    // one pass; it has its own hourly ceiling and never counts against the
    // per-record breaker, but a tripped breaker still stops it.
    while (bulkWriteTimes.length && now - bulkWriteTimes[0] > 60 * 60 * 1000) bulkWriteTimes.shift();
    if (bulkWriteTimes.length + 1 > BULK_LIMIT_1_HOUR) {
      breaker.tripped = true; breaker.at = new Date(); breaker.lastAction = action;
      breaker.reason = `${bulkWriteTimes.length + 1} bulk writes in 1 h (limit ${BULK_LIMIT_1_HOUR}); last action ${action}`;
      logger.error('ZENOTI WRITE BREAKER TRIPPED (bulk) — all writes to Zenoti paused', breaker);
      throw new Error(`Zenoti write-back paused by safety breaker: ${breaker.reason}`);
    }
    bulkWriteTimes.push(now);
    breaker.lastAction = action;
    return fn();
  }
  const in15 = writeTimes.filter((t) => now - t <= 15 * 60 * 1000).length;
  if (in15 + 1 > LIMIT_15_MIN || writeTimes.length + 1 > LIMIT_1_HOUR) {
    breaker.tripped = true; breaker.at = new Date(); breaker.lastAction = action;
    breaker.reason = `${in15 + 1} writes in 15 min / ${writeTimes.length + 1} in 1 h (limits ${LIMIT_15_MIN}/${LIMIT_1_HOUR}); last action ${action}`;
    logger.error('ZENOTI WRITE BREAKER TRIPPED — all writes to Zenoti paused', breaker);
    throw new Error(`Zenoti write-back paused by safety breaker: ${breaker.reason}`);
  }
  writeTimes.push(now);
  breaker.lastAction = action;
  return fn();
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
/** Loose name key: case, punctuation, spacing and tier words ignored. */
const looseKey = (s) => norm(s)
  .replace(/\b(senior|junior|dermatologist|dr\.?|doctor|treatment|session|the)\b/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

/**
 * Resolve one of our consultations to a Zenoti service id for a centre.
 * Order: the mapping chosen in the panel (zenotiServiceId) → env override map
 * → code → exact name → loose name → for a consultation-type entry, Zenoti's
 * generic "Consultation". Bookable (catalog) services are preferred.
 */
/**
 * A date of birth in the only shape Zenoti accepts: yyyy-mm-dd.
 *
 * `User.dateOfBirth` is free text, and the app and the panel have written it
 * both ways. Zenoti rejects anything else with "date_of_birth is mandatory" —
 * which reads as a missing field, so the real cause (a dd/mm/yyyy string) hid
 * behind a misleading message. The guest is then never created, and every
 * booking for them dies with "Guest is not in Zenoti yet".
 */
function zenotiDob(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return undefined;
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const dmy = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString().slice(0, 10);
}

async function resolveServiceId(centerId, consultation) {
  if (!consultation) return null;
  if (consultation.zenotiServiceId) return String(consultation.zenotiServiceId).toLowerCase();
  const overrides = parseJsonEnv('ZENOTI_SERVICE_MAP');
  const keys = [consultation._id?.toString(), consultation.slug, consultation.name].filter(Boolean);
  for (const k of keys) if (overrides[k]) return overrides[k];

  const services = await zenoti.getCenterServices(centerId).catch(() => []);
  if (!services.length) return null;
  const preferBookable = (list) => list.find((s) => s.canBook !== false) || list[0] || null;
  const byCode = consultation.code && services.filter((s) => norm(s.code) === norm(consultation.code));
  if (byCode && byCode.length) return preferBookable(byCode).id;
  const exact = services.filter((s) => norm(s.name) === norm(consultation.name));
  if (exact.length) return preferBookable(exact).id;
  const loose = services.filter((s) => looseKey(s.name) && looseKey(s.name) === looseKey(consultation.name));
  if (loose.length) return preferBookable(loose).id;
  const isConsultation = /^consultations?$/i.test(String(consultation.category || '').trim()) || /consultation/i.test(consultation.name || '');
  if (isConsultation) {
    const generic = services.filter((s) => norm(s.name) === 'consultation' || norm(s.code) === 'consultation');
    if (generic.length) return preferBookable(generic).id;
  }
  return null;
}

/** Resolve a local Package (or assignment snapshot) to a Zenoti package id. */
async function resolvePackageId(centerId, pkg) {
  if (!pkg) return null;
  if (pkg.zenotiPackageId) return String(pkg.zenotiPackageId).toLowerCase();
  const overrides = parseJsonEnv('ZENOTI_PACKAGE_MAP');
  const keys = [pkg._id?.toString(), pkg.id, pkg.name].filter(Boolean);
  for (const k of keys) if (overrides[k]) return overrides[k];
  const packages = await zenoti.getCenterPackages(centerId).catch(() => []);
  const active = packages.filter((p) => p.active);
  const byCode = pkg.code && active.find((p) => norm(p.code) === norm(pkg.code));
  if (byCode) return byCode.id;
  // Exact name only: a loose guess could sell the guest the wrong package.
  const exact = active.find((p) => norm(p.name) === norm(pkg.name));
  return exact ? exact.id : null;
}

/** The Zenoti employee to book/update with for a booking's dermatologist, if linked. */
async function resolveTherapistId(booking) {
  if (booking.zenotiTherapistId) return booking.zenotiTherapistId;
  if (!booking.specialistId) return null;
  const ZenotiPractitioner = require('../models/ZenotiPractitioner');
  const centerId = strictClinicCenterIdForBranch(booking.preferredLocation);
  const rows = await ZenotiPractitioner.find({
    onboardedDoctorId: String(booking.specialistId).toLowerCase(),
    active: true,
    centerIds: centerId,
  }).select('zenotiEmployeeId name').limit(3).lean();
  if (rows.length > 1) {
    throw new Error(`Doctor ${booking.specialistId} has multiple active Zenoti employee links at ${booking.preferredLocation}. Resolve the duplicate before booking.`);
  }
  if (!rows.length) {
    throw new Error(`Doctor ${booking.specialistId} is not linked to a Zenoti employee at ${booking.preferredLocation}.`);
  }
  return rows[0].zenotiEmployeeId;
}

/** Booking writes may never fall back to a different clinic. */
function strictClinicCenterIdForBranch(branchName) {
  const wanted = String(branchName || '').trim().toLowerCase();
  const match = Object.entries(CENTERS).find(([, center]) =>
    center.isClinic && String(center.branchName).trim().toLowerCase() === wanted);
  if (!match) throw new Error(`"${branchName || 'Unknown clinic'}" is not mapped to a Zenoti clinic.`);
  return match[0];
}

/** Who Zenoti records as the updater: env, else the visit's own provider. */
/**
 * Which Zenoti employee a desk action is recorded against.
 *
 * The provider who actually saw the guest comes FIRST; ZENOTI_UPDATED_BY_ID is
 * only the fallback for a provider with no Zenoti link. The old order was the
 * other way round, so the moment that env var was set every check-in, start and
 * completion in the clinic's Zenoti audit trail would have been stamped with
 * one service account instead of the real dermatologist — the attribution the
 * clinic reads to see who did what.
 *
 * When neither is available we rethrow resolveTherapistId's message, which
 * names the doctor and the clinic, rather than a generic failure.
 */
async function resolveUpdatedById(booking) {
  try {
    const providerId = await resolveTherapistId(booking);
    if (providerId) return providerId;
  } catch (err) {
    if (!process.env.ZENOTI_UPDATED_BY_ID) throw err;
  }
  return process.env.ZENOTI_UPDATED_BY_ID || null;
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
  if (isOff()) {
    // Not an error, but it must be visible: the patient exists only here.
    if (user.zenotiSyncStatus !== 'pending') {
      user.zenotiSyncStatus = 'pending';
      user.zenotiSyncError = 'Zenoti write mode is off — will sync when enabled.';
      await user.save({ validateModifiedOnly: true }).catch(() => {});
    }
    return null;
  }

  const phone = normalizeIndianMobile(user.phone);
  const centerId = clinicCenterIdForBranch(user.location);

  // Never create a duplicate — a matching guest may already exist in Zenoti.
  try {
    const existing = phone ? await zenoti.findGuestByPhone(phone) : null;
    if (existing?.zenotiGuestId) {
      user.zenotiGuestId = existing.zenotiGuestId;
      user.zenotiCenterId = existing.centerId || centerId;
      /*
       * A phone match links the accounts, but a phone is not an identity —
       * families share numbers, and a number gets reassigned. When Zenoti's
       * name for this guest shares no word with ours, the link is kept (so no
       * duplicate is created) but the record is flagged `review` so the desk
       * confirms it is the same person before anything clinical is attached.
       */
      const ours = String(user.fullName || '').toLowerCase().split(/\s+/).filter((w) => w.length > 1);
      const theirs = String(existing.fullName || '').toLowerCase().split(/\s+/).filter((w) => w.length > 1);
      const nameMismatch = ours.length && theirs.length
        && !ours.some((w) => theirs.includes(w)) && user.fullName !== 'Zennara Guest';
      user.zenotiSyncStatus = nameMismatch ? 'review' : 'synced';
      user.zenotiSyncError = nameMismatch
        ? `Zenoti has this number under "${existing.fullName}" — confirm it is the same person.`
        : null;
      user.zenotiSyncedAt = new Date();
      await user.save({ validateModifiedOnly: true });
      logger.info('Linked user to existing Zenoti guest', { userId: user._id, review: Boolean(nameMismatch) });
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
      date_of_birth: zenotiDob(user.dateOfBirth),
    },
  };

  // This Zenoti org makes a referral source MANDATORY for API-created guests
  // ("referral_source is mandatory"). The valid id comes from the org's config
  // (Zenoti portal → Admin/Setup → Referral Sources) and isn't exposed to this
  // API key. Set ZENOTI_REFERRAL_SOURCE_ID in .env and it's attached here.
  // Default: the org's "Internet" source (id read live from /centers/{id}/referrals).
  const referralSourceId = process.env.ZENOTI_REFERRAL_SOURCE_ID || 'c196993f-e7c7-45b5-a51f-c8b664b21282';
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
    const res = await liveWrite('createGuest', () => zenoti.request('/v1/guests', { method: 'POST', body: payload }));
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
    const dob = zenotiDob(user.dateOfBirth);
    if (dob) payload.personal_info.date_of_birth = dob;

    logWrite('updateGuest', { guestId: user.zenotiGuestId, changedBy: 'Zennara' }, { userId: user._id });
    if (!isLive()) {
      user.zenotiSyncStatus = 'dryrun';
    } else {
      await liveWrite('updateGuest', () => zenoti.request(`/v1/guests/${user.zenotiGuestId}`, { method: 'PUT', body: payload }));
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
      const result = await liveWrite(note.zenotiNoteId ? 'updateNote' : 'createNote', () => zenoti.request(
        note.zenotiNoteId
          ? `/v1/guests/${user.zenotiGuestId}/notes/${note.zenotiNoteId}`
          : `/v1/guests/${user.zenotiGuestId}/notes`,
        { method: note.zenotiNoteId ? 'PUT' : 'POST', body: payload }
      ));
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
    // The panel's membership card names the Zenoti membership it sells;
    // the env is only a fallback for installs that never set it.
    const settings = await require('../models/AppCustomization').getSettings().catch(() => null);
    const membershipVersionIds = settings?.membership?.zenotiMembershipVersionId
      || process.env.ZENOTI_MEMBERSHIP_VERSION_IDS || process.env.ZENOTI_MEMBERSHIP_ID;
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
      const result = await liveWrite('createMembershipInvoice', () => zenoti.request('/api/Catalog/Memberships/CreateInvoice', { method: 'POST', body: payload }));
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
    const Package = require('../models/Package');
    const centerId = clinicCenterIdForBranch(assignment.preferredLocation || user?.location);
    const localPackage = assignment.packageId ? await Package.findById(assignment.packageId).lean().catch(() => null) : null;
    const packageId = await resolvePackageId(centerId, localPackage || { name: assignment.packageDetails?.packageName });
    // Documented ("Ability to sell series regular packages in API"):
    // POST /v1/invoices/packages { guest_id, center_id, notes, package_details:[{id}] }
    // → { invoice_id, invoice_number }. Verified live that this route exists
    // here (it validates the guest); the legacy /Catalog/SeriesPackages path 404s.
    const payload = {
      guest_id: guestId,
      center_id: centerId,
      notes: `Zennara package ${assignment.assignmentId}`,
      package_details: packageId ? [{ id: packageId }] : [],
    };
    assignment.zenotiPackageId = packageId;
    if (!guestId || !packageId) {
      assignment.zenotiSyncStatus = isLive() ? 'skipped' : 'dryrun';
      assignment.zenotiSyncError = !guestId
        ? 'unresolved: guest is not in Zenoti yet'
        : `No Zenoti package is mapped to "${assignment.packageDetails?.packageName || 'this package'}" — choose one on the package in the panel.`;
    } else if (!isLive()) {
      assignment.zenotiSyncStatus = 'dryrun';
      assignment.zenotiSyncError = null;
      logWrite('createPackageInvoice', payload, { assignmentId: assignment._id });
    } else {
      const result = await liveWrite('createPackageInvoice', () => zenoti.request('/v1/invoices/packages', { method: 'POST', body: payload }));
      assignment.zenotiInvoiceId = result?.invoice_id || result?.id || result?.Invoice?.Id || null;
      if (!assignment.zenotiInvoiceId) throw new Error(result?.Error?.Message || result?.error?.message || 'Zenoti package invoice returned no id.');
      assignment.zenotiInvoiceNumber = result?.invoice_number || null;
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

/**
 * Push a package's new expiry date back to Zenoti.
 *
 * Only ever called for an assignment that mirrors a real Zenoti user-package
 * (`zenotiUserPackageId`); a package sold in the app has nothing to update
 * there. Like every other edit to a record Zenoti owns it is behind
 * ZENOTI_EDIT_EXISTING_WRITEBACK, so it stays inert until that is switched on.
 *
 * Returns { status, error } and never throws — the extension itself has already
 * been applied on our side, and a Zenoti failure must not undo it. The status is
 * recorded on the extension entry so the panel can show that the clinic's own
 * system is still on the old date.
 */
async function syncPackageExpiry(assignmentId) {
  const PackageAssignment = require('../models/PackageAssignment');
  const assignment = await PackageAssignment.findById(assignmentId);
  if (!assignment) return { status: 'skipped', error: 'Assignment not found.' };
  if (!assignment.zenotiUserPackageId) {
    return { status: 'skipped', error: 'Sold in the app — Zenoti has no copy of this package.' };
  }
  if (isOff()) return { status: 'skipped', error: 'Zenoti write mode is off.' };
  if (!existingRecordWritebackEnabled()) {
    return { status: 'skipped', error: 'Zenoti write-back for existing records is disabled (ZENOTI_EDIT_EXISTING_WRITEBACK).' };
  }

  const User = require('../models/User');
  const user = await User.findById(assignment.userId).select('zenotiGuestId').lean();
  if (!user?.zenotiGuestId) {
    return { status: 'skipped', error: 'This guest is not linked to Zenoti yet.' };
  }

  const payload = {
    expiry_date: clinicDay(assignment.validUntil),
    // Zenoti names this field differently across its package endpoints; both
    // are sent so whichever the tenant's API honours takes effect.
    end_date: clinicDay(assignment.validUntil),
  };
  const path = `/v1/guests/${user.zenotiGuestId}/packages/${assignment.zenotiUserPackageId}`;

  if (!isLive()) {
    logWrite('updatePackageExpiry', { path, payload }, { assignmentId });
    return { status: 'dryrun', error: null };
  }
  try {
    await liveWrite('updatePackageExpiry', () => zenoti.request(path, { method: 'PUT', body: payload }));
    return { status: 'synced', error: null };
  } catch (error) {
    logger.warn('Zenoti package expiry write-back failed', { assignmentId, error: error.message });
    return { status: 'failed', error: error.message };
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

  let booking = await Booking.findById(bookingId);
  if (!booking) return { status: 'not_found', error: 'Booking not found.' };
  if (booking.zenotiAppointmentId) return { status: 'synced', error: null, appointmentId: booking.zenotiAppointmentId };
  if (booking.zenotiBookingId) {
    return {
      status: 'reconciliation_required',
      error: `Zenoti booking ${booking.zenotiBookingId} was created but not confirmed. Reconcile it in Zenoti before retrying; a second create is blocked to prevent duplicates.`,
    };
  }
  if (isOff()) return { status: 'off', error: 'Zenoti write mode is off or credentials are unavailable.' };

  const writeToken = require('crypto').randomUUID();
  const staleBefore = new Date(Date.now() - 2 * 60 * 1000);
  booking = await Booking.findOneAndUpdate(
    {
      _id: bookingId,
      zenotiAppointmentId: null,
      zenotiBookingId: null,
      $or: [
        { 'zenotiWriteLock.token': null },
        { 'zenotiWriteLock.token': { $exists: false } },
        { 'zenotiWriteLock.at': { $lt: staleBefore } },
      ],
    },
    { $set: { zenotiWriteLock: { token: writeToken, at: new Date() } } },
    { new: true },
  );
  if (!booking) return { status: 'in_progress', error: 'This booking is already being written to Zenoti. Refresh before retrying.' };

  try {
    const user = await User.findById(booking.userId);
    const guestId = await ensureGuest(user);
    if (user?.zenotiSyncStatus === 'review') {
      throw new Error(user.zenotiSyncError || 'The phone matches a different-looking Zenoti guest. Reception must verify the identity before confirming this appointment.');
    }
    const centerId = strictClinicCenterIdForBranch(booking.preferredLocation);
    const consultation = booking.consultationId
      ? await Consultation.findById(booking.consultationId).lean()
      : null;
    const serviceId = await resolveServiceId(centerId, consultation);
    const therapistId = await resolveTherapistId(booking);

    // Prefer the confirmed date/time, else the requested one.
    const date = clinicDay(booking.confirmedDate || booking.preferredDate || new Date());

    /*
     * A visit booked at the desk with several services is ONE visit.
     *
     * The panel writes a booking per service, tied together by visitGroupId.
     * Pushing them one at a time gave Zenoti three unrelated appointments for
     * the same guest at the same hour, which the desk then has to reconcile by
     * hand — and if the second service had no mapping, half the visit silently
     * went missing. Zenoti takes several services in one booking, so the whole
     * group goes together and every line comes back with its own appointment
     * id under one group id.
     */
    const siblings = booking.visitGroupId
      ? await Booking.find({
        visitGroupId: booking.visitGroupId,
        zenotiAppointmentId: null,
        status: { $nin: ['Cancelled', 'No Show'] },
      }).sort({ createdAt: 1 })
      : [];
    // The first sibling to run pushes the whole group; the others are marked
    // synced from its result, so two of them cannot open two Zenoti bookings.
    if (siblings.length > 1 && String(siblings[0]._id) !== String(booking._id)) {
      logger.info('Skipping: another line of this visit group is pushing it', { bookingId: booking._id, visitGroupId: booking.visitGroupId });
      return { status: 'pending', error: 'Another line in this visit group is creating the shared Zenoti booking.' };
    }

    const groupItems = [];
    const groupLines = [];
    if (siblings.length > 1) {
      const primaryTime = require('../utils/bookingTime').clock24(
        booking.confirmedTime || booking.slotTime || booking.preferredTimeSlots?.[0],
      );
      for (const sib of siblings) {
        const siblingDate = clinicDay(sib.confirmedDate || sib.preferredDate);
        const siblingTime = require('../utils/bookingTime').clock24(
          sib.confirmedTime || sib.slotTime || sib.preferredTimeSlots?.[0],
        );
        if (strictClinicCenterIdForBranch(sib.preferredLocation) !== centerId
          || siblingDate !== date || siblingTime !== primaryTime) {
          throw new Error('Services in one visit must use the same Zenoti clinic, date, and start time. Split this group into separate visits before confirming.');
        }
        const sibConsultation = sib.consultationId ? await Consultation.findById(sib.consultationId).lean().catch(() => null) : null;
        const sibServiceId = await resolveServiceId(centerId, sibConsultation);
        if (!sibServiceId) {
          // One unmapped line must not silently drop out of a visit.
          throw new Error(`"${sibConsultation?.name || 'a service in this visit'}" has no Zenoti service mapped, so the whole visit was not booked. Map it, then push again.`);
        }
        const sibTherapist = await resolveTherapistId(sib);
        groupItems.push({ item: { id: sibServiceId }, ...(sibTherapist ? { therapist: { id: sibTherapist, gender: 3 } } : {}) });
        groupLines.push({ booking: sib, serviceId: sibServiceId });
      }
    }

    const payload = {
      center_id: centerId,
      date,
      is_only_catalog_employees: false,
      guests: [
        {
          id: guestId,
          // Booking therapist gender enum: 0 any, 3 = this specific employee.
          items: groupItems.length
            ? groupItems
            : [{ item: { id: serviceId }, ...(therapistId ? { therapist: { id: therapistId, gender: 3 } } : {}) }],
        },
      ],
      notes: `Zennara ${booking.source === 'reception' ? 'reception' : 'app'} booking ${booking.referenceNumber || booking._id}`,
    };

    // Can't proceed without a guest + service mapping.
    const missing = [];
    if (!guestId) missing.push('guestId');
    if (!serviceId) missing.push('serviceId');
    if (missing.length) {
      booking.zenotiSyncStatus = isLive() ? 'skipped' : 'dryrun';
      booking.zenotiSyncError = missing.includes('serviceId')
        ? `No Zenoti service is mapped to "${consultation?.name || 'this service'}" — choose one on the service in the panel.`
        : 'Guest is not in Zenoti yet.';
      await booking.save({ validateModifiedOnly: true }).catch(() => {});
      logWrite('bookAppointment(skipped)', payload, { bookingId: booking._id, missing });
      return { status: booking.zenotiSyncStatus, error: booking.zenotiSyncError };
    }

    logWrite('bookAppointment', payload, { bookingId: booking._id });
    if (!isLive()) {
      booking.zenotiSyncStatus = 'dryrun';
      await booking.save({ validateModifiedOnly: true }).catch(() => {});
      return { status: 'dryrun', error: 'ZENOTI_WRITE_MODE is not live; no Zenoti appointment was created.' };
    }

    // Zenoti booking flow: create booking → get slots → reserve → confirm.
    const created = await liveWrite('bookAppointment', () => zenoti.request('/v1/bookings', { method: 'POST', body: payload }));
    const zBookingId = created?.id || created?.Id;
    if (!zBookingId) throw new Error('Zenoti booking create returned no id');
    // Record the ids as soon as they exist. If the reserve/confirm steps below
    // fail we still know which Zenoti booking was opened, instead of leaving an
    // orphan behind with nothing linking back to it.
    booking.zenotiBookingId = zBookingId;
    booking.zenotiGuestId = guestId;
    booking.zenotiSyncStatus = 'pending';
    await booking.save({ validateModifiedOnly: true }).catch(() => {});

    const slotsRes = await zenoti.request(`/v1/bookings/${zBookingId}/slots`, { method: 'GET' });
    /*
     * Zenoti answers a failed slot search with HTTP 200 and { slots: null,
     * Error: { StatusCode, Message } } — the failure is in the BODY, not the
     * status. Reading only `slots` turned every distinct cause into the same
     * "staff shifts are not published" guess below, which on 2026-09-07 sent
     * the desk off to publish rosters that were already published while the
     * real answer ("One or more services or addons are not available in the
     * catalog", account-wide) sat unread in the response. Never swallow it.
     */
    const zErr = slotsRes?.Error || slotsRes?.error || null;
    const zErrMsg = String(zErr?.Message || zErr?.message || '').trim();
    const slots = slotsRes?.slots || slotsRes?.Slots || [];
    const wantedTime = require('../utils/bookingTime').clock24(
      booking.confirmedTime || booking.slotTime || booking.preferredTimeSlots?.[0] || null,
    );
    const slotValue = (slot) => slot && (slot.Time || slot.time || slot.slot_time || slot.start_time);
    const bookableSlots = slots.filter((slot) => (slot.Available ?? slot.available) !== false);
    const slotTime = wantedTime
      ? slotValue(bookableSlots.find((slot) => String(slotValue(slot) || '').includes(`T${wantedTime}`)))
      : slotValue(bookableSlots[0]);
    if (!slotTime) {
      if (slots.length) {
        throw new Error(`Zenoti has no free slot at ${wantedTime || 'the requested time'} on ${date} (${bookableSlots.length} other slots free).`);
      }
      // Zenoti told us why — pass its words through rather than guessing.
      if (zErrMsg) {
        throw new Error(`Zenoti returned no slots for ${date}: ${zErrMsg}${zErr?.StatusCode ? ` (Zenoti code ${zErr.StatusCode})` : ''}`);
      }
      // Silent empty list: now the roster really is the likely culprit, but say
      // so as a diagnosis to check, not as fact.
      throw new Error(`Zenoti returned no slots for ${date} and gave no reason. Most often the provider's shift is not published in Zenoti for that day — check the roster, then push again.`);
    }

    await liveWrite('reserveSlot', () => zenoti.request(`/v1/bookings/${zBookingId}/slots/reserve`, {
      method: 'POST',
      body: { slot_time: slotTime },
    }));
    const confirmed = await liveWrite('confirmSlot', () => zenoti.request(`/v1/bookings/${zBookingId}/slots/confirm`, {
      method: 'POST',
      body: { notes: payload.notes },
    }));

    const invoice = confirmed?.invoice || confirmed?.Invoice || {};
    const item = (invoice.items || invoice.Items || [])[0] || {};
    booking.zenotiAppointmentId =
      item.appointment_id || item.AppointmentId || confirmed?.appointment_id || zBookingId;
    booking.zenotiInvoiceId = invoice.invoice_id || invoice.id || confirmed?.invoice_id || null;
    booking.zenotiInvoiceItemId = item.invoice_item_id || item.InvoiceItemId || null;
    booking.zenotiAppointmentGroupId =
      confirmed?.appointment_group_id || invoice.appointment_group_id || invoice.AppointmentGroupId || null;
    booking.zenotiServiceId = serviceId;
    booking.zenotiGuestId = guestId;
    booking.zenotiSyncStatus = 'synced';
    booking.zenotiSyncedAt = new Date();
    booking.zenotiSyncError = null;
    await booking.save({ validateModifiedOnly: true });

    // Each line of a multi-service visit gets its own appointment id from the
    // same confirm, matched back by the service it was booked for.
    if (groupLines.length > 1) {
      const items = invoice.items || invoice.Items || [];
      for (const { booking: sib, serviceId: sibServiceId } of groupLines) {
        if (String(sib._id) === String(booking._id)) continue;
        const match = items.find((it) => String(it.service_id || it.ServiceId || '').toLowerCase() === String(sibServiceId).toLowerCase())
          || items.find((it) => !(it._claimed) && (it._claimed = true));
        sib.zenotiBookingId = zBookingId;
        sib.zenotiGuestId = guestId;
        sib.zenotiAppointmentId = match?.appointment_id || match?.AppointmentId || booking.zenotiAppointmentId;
        sib.zenotiInvoiceId = booking.zenotiInvoiceId;
        sib.zenotiInvoiceItemId = match?.invoice_item_id || match?.InvoiceItemId || null;
        sib.zenotiAppointmentGroupId = booking.zenotiAppointmentGroupId;
        sib.zenotiServiceId = sibServiceId;
        sib.zenotiSyncStatus = 'synced';
        sib.zenotiSyncedAt = new Date();
        sib.zenotiSyncError = null;
        sib.$locals.skipZenotiWrite = true;
        await sib.save({ validateModifiedOnly: true }).catch(() => {});
      }
      logger.info('Pushed a multi-service visit to Zenoti as one booking', { visitGroupId: booking.visitGroupId, lines: groupLines.length });
    }
    logger.info('Pushed booking to Zenoti', { bookingId: booking._id });
    return {
      status: 'synced',
      error: null,
      appointmentId: booking.zenotiAppointmentId,
      bookingId: booking.zenotiBookingId,
      invoiceId: booking.zenotiInvoiceId,
    };
  } catch (err) {
    booking.zenotiSyncStatus = 'failed';
    booking.zenotiSyncError = err.message;
    await booking.save({ validateModifiedOnly: true }).catch(() => {});
    logger.error('Zenoti syncBooking failed', { bookingId, error: err.message });
    return { status: 'failed', error: err.message, bookingId: booking.zenotiBookingId || null };
  } finally {
    await Booking.updateOne(
      { _id: bookingId, 'zenotiWriteLock.token': writeToken },
      { $unset: { zenotiWriteLock: 1 } },
      { timestamps: false },
    ).catch(() => {});
  }
}


/**
 * Retry bookings that were created here but never reached Zenoti.
 *
 * Legacy rows created before confirmation became Zenoti-first can still be
 * confirmed locally without an appointment id. This repairs only those rows;
 * current confirmation flows never expose Confirmed before Zenoti succeeds.
 *
 * Deliberately conservative:
 *   · only future appointments, and only CONFIRMED ones — a booking still
 *     awaiting the clinic's confirmation must not be created in Zenoti, and a
 *     past or cancelled one must never be created after the fact
 *   · never touches rows that already carry an appointment id
 *   · never touches source:'zenoti' mirrors (they came FROM Zenoti)
 *   · small batches, so a systemic failure cannot turn into a write storm
 *     against the CRM — this is the same class of mistake as the automated
 *     no-show job that wrote hundreds of rows into Zenoti
 */
async function retryFailedBookingPushes({ limit = 10, trigger = 'schedule' } = {}) {
  if (isOff()) return { attempted: 0, reason: 'write mode off' };
  const Booking = require('../models/Booking');

  const candidates = await Booking.find({
    source: { $in: ['app', 'reception'] },
    zenotiAppointmentId: null,
    zenotiSyncStatus: { $in: ['failed', 'pending'] },
    // A push that already opened a Zenoti booking (create succeeded, reserve or
    // confirm did not) is NOT retried automatically: a second create would
    // duplicate it. Those stay flagged in the panel for the desk's "Create in
    // Zenoti now", which a person can check against Zenoti's diary first.
    zenotiBookingId: null,
    // Confirmed or later: an unconfirmed booking has no business in Zenoti
    // yet, but one the guest has already arrived for certainly does — a
    // check-in on a booking that never made it across is exactly the gap this
    // retry exists to close.
    status: { $in: ['Confirmed', 'Checked In', 'In Progress'] },
    // Today onwards: a guest currently in the building has a slot that is
    // already a few minutes in the past.
    eventAt: { $gte: new Date(Date.now() - 12 * 60 * 60 * 1000) },
  })
    .sort({ eventAt: 1 })
    .limit(Math.min(Number(limit) || 10, 25))
    .select('_id')
    .lean();

  let attempted = 0;
  for (const row of candidates) {
    // Sequential on purpose: the breaker in liveWrite counts failures, and a
    // parallel burst would trip it on the first bad batch.
    await syncBooking(row._id).catch(() => {});
    attempted += 1;
  }
  if (attempted) logger.info('Retried Zenoti booking pushes', { attempted, trigger });
  return { attempted };
}

/** Resolve identifiers missing on records created by the older write parser. */
async function hydrateAppointmentIds(booking) {
  if (!booking.zenotiAppointmentId) return;
  try {
    const detail = await zenoti.getAppointment(booking.zenotiAppointmentId);
    booking.zenotiInvoiceId = booking.zenotiInvoiceId || detail?.invoiceId || null;
    booking.zenotiInvoiceItemId = booking.zenotiInvoiceItemId || detail?.invoiceItemId || null;
    booking.zenotiAppointmentGroupId = booking.zenotiAppointmentGroupId || detail?.appointmentGroupId || null;
    booking.zenotiAppointmentSegmentId = booking.zenotiAppointmentSegmentId || detail?.appointmentSegmentId || null;
    booking.zenotiServiceId = booking.zenotiServiceId || detail?.serviceId || null;
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
  const bookable = slots.filter((slot) => (slot.Available ?? slot.available) !== false);
  const canonicalTime = require('../utils/bookingTime').clock24(time);
  const chosen = canonicalTime
    ? valueOf(bookable.find((slot) => String(valueOf(slot) || '').includes(`T${canonicalTime}`)))
    : valueOf(bookable[0]);
  if (!chosen) throw new Error(`Requested Zenoti slot ${canonicalTime || time || ''} is unavailable on ${date}`.trim());
  await liveWrite('reserveSlot', () => zenoti.request(`/v1/bookings/${bookingId}/slots/reserve`, { method: 'POST', body: { slot_time: chosen } }));
  return liveWrite('confirmSlot', () => zenoti.request(`/v1/bookings/${bookingId}/slots/confirm`, { method: 'POST', body: {} }));
}

/** Reschedule using Zenoti's documented create → reserve → confirm workflow. */
async function rescheduleLinkedBooking(booking, user) {
  const { date, time } = bookingDateAndTime(booking);
  if (!booking.zenotiInvoiceId || !booking.zenotiInvoiceItemId || !booking.zenotiServiceId) {
    throw new Error('Zenoti reschedule identifiers are incomplete; wait for the next inbound reconciliation and retry.');
  }
  const payload = {
    center_id: strictClinicCenterIdForBranch(booking.preferredLocation),
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
  const created = await liveWrite('rescheduleAppointment', () => zenoti.request('/v1/bookings', { method: 'POST', body: payload }));
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
  // On by default (desk attendance must reach Zenoti); set to false to pause.
  return String(process.env.ZENOTI_LIFECYCLE_WRITEBACK || 'true').toLowerCase() !== 'false';
}
/**
 * Editing an EXISTING Zenoti record (guest profile, an existing note) is a
 * second opt-in, separate from creating new records. Default off: a wrong
 * field in a PUT overwrites what the clinic entered.
 */
function existingRecordWritebackEnabled() {
  return String(process.env.ZENOTI_EDIT_EXISTING_WRITEBACK || 'false').toLowerCase() === 'true';
}

/**
 * Which Zenoti call each desk action makes.
 *
 * Verified against the live API on 2026-09-07 with nil ids (nothing created):
 *   check_in        PUT /v1/appointments/{group}/check_in        → permitted
 *   undo_check_in   PUT /v1/appointments/{group}/undo_check_in   → permitted
 *   progress        PUT /v1/appointments/{id}/progress           → permitted
 *                     progress 0 = not started, 1 = in service, 2 = closed
 *                     ...but NOT backwards out of 2: reopening a closed visit
 *                     returns 200 with { error: AA102 }, so the desk's
 *                     "Reopen session" was retired on 2026-09-08.
 *   confirm         PUT /v1/invoices/{id}/confirm                → permitted
 *   cancel          PUT /v1/invoices/{id}/cancel                 → permitted
 *   no_show         PUT /v1/appointments/{group}/no_show         → 401 DENIED
 *
 * `no_show` is the one Zenoti refuses for this organisation's API user ("User
 * does not have authorization", code 438). It is still attempted so the reason
 * is recorded on the booking and visible at the desk; the clinic has to grant
 * the permission in Zenoti for it to succeed. Zenoti exposes no undo_no_show
 * route at all (404), so that correction stays local.
 */
const LIFECYCLE_CALLS = {
  confirm: async (ctx) => {
    if (!ctx.invoiceId || !ctx.updatedById) throw new Error('Zenoti needs the invoice id and ZENOTI_UPDATED_BY_ID to confirm an appointment.');
    return liveWrite('confirm', () => zenoti.request(`/v1/invoices/${ctx.invoiceId}/confirm`, {
      method: 'PUT', body: { updated_by_id: ctx.updatedById },
    }));
  },
  check_in: async (ctx) => {
    if (!ctx.groupId) throw new Error('Zenoti needs the appointment group id to check a guest in.');
    return liveWrite('checkIn', () => zenoti.request(`/v1/appointments/${ctx.groupId}/check_in`, { method: 'PUT' }));
  },
  undo_check_in: async (ctx) => {
    if (!ctx.groupId) throw new Error('Zenoti needs the appointment group id to undo a check-in.');
    return liveWrite('undoCheckIn', () => zenoti.request(`/v1/appointments/${ctx.groupId}/undo_check_in`, { method: 'PUT' }));
  },
  start: (ctx) => progressWrite(ctx, 1, 'progressStart'),
  undo_start: (ctx) => progressWrite(ctx, 0, 'progressUndoStart'),
  complete: (ctx) => progressWrite(ctx, 2, 'progressComplete'),
  no_show: async (ctx) => {
    if (!ctx.groupId) throw new Error('Zenoti needs the appointment group id to mark a no-show.');
    try {
      return await liveWrite('noShow', () => zenoti.request(`/v1/appointments/${ctx.groupId}/no_show`, {
        method: 'PUT', body: { comments: ctx.booking.cancellationReason || 'No show recorded in Zennara' },
      }));
    } catch (err) {
      /*
       * Zenoti refuses no_show for this organisation's API user (401, code
       * 438 "User does not have authorization"). The desk sees the raw error
       * otherwise and cannot tell whether the clinic must act or the guest
       * must be chased, so name the fix. Nothing is recorded locally either —
       * apply() treats a failed push as a failed action — which is deliberate:
       * the 2026-09-03 incident began with no-shows diverging from Zenoti.
       */
      if (/401|not have authorization|\b438\b/i.test(String(err.message))) {
        throw new Error('Zenoti will not accept a no-show from the app: its API user lacks that permission (Zenoti error 438). Mark the no-show in Zenoti — it appears here within 2 minutes — or ask Zenoti to grant the permission.');
      }
      throw err;
    }
  },
  cancel: async (ctx) => {
    if (!ctx.invoiceId) throw new Error('Zenoti needs the invoice id to cancel this appointment.');
    /*
     * The payload goes in the BODY, not the query string.
     *
     * Sent as query params this call fails with "invalid reason_id" — Zenoti
     * sees no body at all and rejects the (absent) reason before it looks at
     * anything else. That error reads as "you sent a bad reason id", which
     * sent us hunting for a reason list that does not exist: every
     * `/v1/centers/{id}/reasons?reason_type=N` (0,1,2,3,4,5,6,7,8) returns an
     * empty array, and `/v1/cancel_reasons` is a 404. With the same fields in
     * the body it returns `{ success: true }` and no reason id is needed at
     * all (verified live 2026-09-08 on invoice c2d91571-…).
     *
     * ZENOTI_CANCEL_REASON_ID stays supported for the day the clinic does
     * configure cancel reasons in Zenoti.
     */
    return liveWrite('cancelAppointment', () => zenoti.request(`/v1/invoices/${ctx.invoiceId}/cancel`, {
      method: 'PUT',
      body: {
        comments: ctx.booking.cancellationReason || 'Cancelled from Zennara',
        ...(process.env.ZENOTI_CANCEL_REASON_ID ? { reason_id: process.env.ZENOTI_CANCEL_REASON_ID } : {}),
      },
    }));
  },
  reschedule: async (ctx) => {
    if (!ctx.user?.zenotiGuestId) throw new Error('Booking owner is not linked to a Zenoti guest.');
    return rescheduleLinkedBooking(ctx.booking, ctx.user);
  },
};

/**
 * Zenoti moves a service through its own progress enum rather than a status
 * string, and it insists on knowing which employee made the change.
 */
async function progressWrite(ctx, progress, action) {
  if (!ctx.booking.zenotiAppointmentId) throw new Error('This booking is not linked to a Zenoti appointment.');
  if (!ctx.updatedById) throw new Error('Zenoti needs an updater employee: set ZENOTI_UPDATED_BY_ID, or link the provider to their Zenoti employee record.');
  return liveWrite(action, () => zenoti.request(`/v1/appointments/${ctx.booking.zenotiAppointmentId}/progress`, {
    method: 'PUT',
    body: {
      updated_by_id: ctx.updatedById,
      progress,
      ...(ctx.booking.zenotiAppointmentSegmentId ? { appointment_segment_id: ctx.booking.zenotiAppointmentSegmentId } : {}),
    },
  }));
}

/**
 * Desk actions that Zenoti owns for an appointment IT created. Attendance
 * (check-in / start / completion, and undoing those) is ours to record and is
 * pushed; the schedule itself is changed in Zenoti only.
 *
 * Why: on 2026-09-02/03 the automatic no-show job marked hundreds of mirrored
 * clinic appointments No Show and wrote every one of them into Zenoti. See
 * "Technical Documentation/ZENOTI-NO-SHOW-INCIDENT-2026-09-03.md".
 */
const ZENOTI_OWNED_ALLOWED = new Set([
  'check_in', 'undo_check_in', 'start', 'undo_start', 'complete',
]);

/**
 * Push ONE lifecycle action to Zenoti and report what happened.
 *
 * Unlike the older status-derived path, this is told exactly which action the
 * desk took — the only way to express an undo, since "Confirmed" is the
 * resulting status of both a confirmation and an undone check-in.
 *
 * Always resolves; never throws. Returns { status, error } where status is
 * 'synced' | 'failed' | 'skipped' | 'dryrun' | 'off'.
 */
async function pushLifecycleAction(bookingId, action) {
  const Booking = require('../models/Booking');
  const User = require('../models/User');

  const finish = async (booking, status, error) => {
    if (booking) {
      booking.zenotiSyncStatus = status === 'off' ? booking.zenotiSyncStatus : status;
      booking.zenotiSyncError = error || null;
      booking.zenotiSyncedAt = new Date();
      booking.$locals.skipZenotiWrite = true;
      await booking.save({ validateModifiedOnly: true }).catch(() => {});
    }
    return { status, error: error || null };
  };

  const booking = await Booking.findById(bookingId);
  if (!booking) return { status: 'skipped', error: 'Booking not found' };
  if (isOff()) return { status: 'off', error: 'Zenoti write-back is off (ZENOTI_WRITE_MODE).' };
  if (!lifecycleWritebackEnabled()) {
    return { status: 'skipped', error: 'Zenoti lifecycle write-back is paused (ZENOTI_LIFECYCLE_WRITEBACK=false).' };
  }
  if (!booking.zenotiAppointmentId && !booking.zenotiInvoiceId) {
    /*
     * The guest is standing here, and the appointment never reached Zenoti —
     * a service that wasn't mapped when it was confirmed, or a push that
     * failed. Create it now, then record the attendance against it, rather
     * than leaving a visit that happened with no trace in the CRM.
     */
    if (booking.source !== 'zenoti') {
      await syncBooking(booking._id).catch(() => {});
      const again = await Booking.findById(bookingId).select('zenotiAppointmentId zenotiInvoiceId zenotiAppointmentGroupId zenotiInvoiceItemId zenotiSyncError');
      if (again?.zenotiAppointmentId) {
        booking.zenotiAppointmentId = again.zenotiAppointmentId;
        booking.zenotiInvoiceId = again.zenotiInvoiceId;
        booking.zenotiAppointmentGroupId = again.zenotiAppointmentGroupId;
        booking.zenotiInvoiceItemId = again.zenotiInvoiceItemId;
      } else if (again?.zenotiSyncError) {
        booking.zenotiSyncError = again.zenotiSyncError;
      }
    }
    if (!booking.zenotiAppointmentId && !booking.zenotiInvoiceId) {
      return finish(booking, 'skipped',
        booking.zenotiSyncError || 'This booking is not in Zenoti yet, so the change could not be recorded there.');
    }
  }
  if (booking.source === 'zenoti' && !ZENOTI_OWNED_ALLOWED.has(action)) {
    return finish(booking, 'skipped',
      `Not written: this appointment was booked in Zenoti, so ${action.replace(/_/g, ' ')} is done in Zenoti itself.`);
  }

  const call = LIFECYCLE_CALLS[action];
  if (!call) return finish(booking, 'skipped', `Zenoti has no equivalent for "${action}".`);

  try {
    await hydrateAppointmentIds(booking);
    const ctx = {
      booking,
      user: await User.findById(booking.userId).select('zenotiGuestId'),
      updatedById: await resolveUpdatedById(booking),
      invoiceId: booking.zenotiInvoiceId || booking.zenotiAppointmentId,
      groupId: booking.zenotiAppointmentGroupId,
    };
    logWrite(`lifecycle:${action}`, {
      bookingId: String(booking._id), invoiceId: ctx.invoiceId, groupId: ctx.groupId, status: booking.status,
    });

    if (!isLive()) return finish(booking, 'dryrun', null);

    await call(ctx);
    return finish(booking, 'synced', null);
  } catch (error) {
    logger.error('Zenoti lifecycle action failed', { bookingId: String(bookingId), action, error: error.message });
    return finish(booking, 'failed', error.message);
  }
}

/**
 * Legacy status-derived write-back, still used by the Booking model's post-save
 * hook for paths that change `status` without going through the lifecycle
 * service (a reschedule, an inbound correction). New desk actions should call
 * `pushLifecycleAction` so an undo can be expressed.
 */
const STATUS_TO_ACTION = {
  Cancelled: 'cancel',
  'No Show': 'no_show',
  'Checked In': 'check_in',
  'In Progress': 'start',
  Completed: 'complete',
  Rescheduled: 'reschedule',
  Confirmed: 'confirm',
};

async function syncBookingState(bookingId, { staffAction = false } = {}) {
  const Booking = require('../models/Booking');
  const booking = await Booking.findById(bookingId).select('status source');
  if (!booking) return;
  if (booking.source === 'zenoti' && !staffAction) {
    logger.info('Zenoti lifecycle write-back refused: Zenoti-owned appointment changed by an automated path', { bookingId, status: booking.status });
    return;
  }
  const action = STATUS_TO_ACTION[booking.status];
  if (!action) return;
  await pushLifecycleAction(bookingId, action);
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
    const res = await liveWrite('createProductInvoice', () => zenoti.request('/v1/invoices/products', { method: 'POST', body: payload }));
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
  retryFailedBookingPushes,
  mode,
  isOff,
  isLive,
  lifecycleWritebackEnabled,
  existingRecordWritebackEnabled,
  breakerStatus,
  resetBreaker,
  liveWrite,
  ensureGuest,
  syncGuestProfile,
  syncConsultationNote,
  syncMembership,
  syncPackageAssignment,
  syncPackageExpiry,
  syncBooking,
  syncBookingState,
  pushLifecycleAction,
  syncOrder,
  resolveServiceId,
  resolveProductId,
  resolvePackageId,
  resolveTherapistId,
  looseKey,
};

/**
 * A form the guest completed in the app (pre-consultation intake, treatment
 * consent) is recorded against the Zenoti guest as a note, so the clinic sees
 * it in the CRM it works from. Zenoti's own form-submission contract is not
 * documented for this key; a note is the reliable, readable equivalent. Never
 * copies medical answers verbatim — a short summary and where to find it.
 */
async function syncFormNote(kind, form) {
  if (!form || isOff()) return;
  try {
    const User = require('../models/User');
    const Booking = require('../models/Booking');
    const user = await User.findById(form.userId).select('zenotiGuestId zenotiCenterId').lean();
    if (!user?.zenotiGuestId) return;
    const booking = form.bookingId ? await Booking.findById(form.bookingId).select('referenceNumber preferredLocation preferredDate').lean() : null;
    const centerId = user.zenotiCenterId || clinicCenterIdForBranch(booking?.preferredLocation);
    const centerName = require('../config/zenoti').centerById(centerId)?.name || booking?.preferredLocation || '';
    const label = kind === 'consent' ? 'Treatment consent form' : 'Pre-consultation form';
    const lines = [
      `${label} completed in the Zennara app on ${clinicDay(new Date())}.`,
      booking ? `Visit: ${booking.referenceNumber || ''} ${booking.preferredDate ? clinicDay(booking.preferredDate) : ''}`.trim() : null,
      kind === 'consent' && form.treatmentProcedure ? `Procedure: ${form.treatmentProcedure}` : null,
      kind === 'consent' ? `Consent given: ${form.consentGiven ? 'yes' : 'no'}${form.marketingPhotoConsent ? ' · photo consent: yes' : ''}` : null,
      'Full answers are in the Zennara panel under the guest\'s Forms.',
    ].filter(Boolean);
    const payload = {
      alert: false,
      center: { id: centerId, name: centerName },
      entity_name: kind === 'consent' ? 'ZennaraConsentForm' : 'ZennaraIntakeForm',
      entity_pk: 0,
      is_private: false,
      note_type: 2,
      notes: lines.join('\n'),
      ...(process.env.ZENOTI_UPDATED_BY_ID ? { added_by: { id: process.env.ZENOTI_UPDATED_BY_ID, name: 'Zennara' } } : {}),
    };
    logWrite(`createFormNote:${kind}`, { guestId: user.zenotiGuestId, characterCount: payload.notes.length }, { formId: form._id });
    if (!isLive()) return;
    await liveWrite('createNote', () => zenoti.request(`/v1/guests/${user.zenotiGuestId}/notes`, { method: 'POST', body: payload }));
  } catch (error) {
    logger.warn('Zenoti form note failed', { kind, formId: form?._id, error: error.message });
  }
}
module.exports.syncFormNote = syncFormNote;
