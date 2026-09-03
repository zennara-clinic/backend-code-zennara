/**
 * Zenoti CRM API client.
 *
 * A thin, read-focused wrapper around Zenoti's v1 REST API. It authenticates
 * with the organisation API key, keeps every caller under Zenoti's 60 req/min
 * org-wide limit, retries transient failures and 429s (honouring Retry-After),
 * and normalises Zenoti's shapes into the ones the Zennara app already speaks.
 *
 * Only the server ever holds the API key. Nothing here is exposed to the client
 * except through the controllers, which return already-normalised, PII-scoped
 * data for the *signed-in* guest only.
 *
 * Docs: https://docs.zenoti.com/reference/
 */

const logger = require('../utils/logger');
const {
  ZENOTI_API_BASE,
  RATE_LIMIT_PER_MINUTE,
  CENTERS,
  centerById,
  branchNameForCenter,
  normalizeGender,
  normalizeIndianMobile,
} = require('../config/zenoti');

const API_KEY = process.env.ZENOTI_API_KEY;

/* --------------------------------------------------------------------------- *
 * Rate limiter — a rolling 60s window, serialised so concurrent callers queue
 * instead of bursting past the org limit.
 * --------------------------------------------------------------------------- */
const callTimestamps = [];
let gate = Promise.resolve();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function acquireSlot() {
  // Serialise slot acquisition so two callers can't both read a stale window.
  const run = gate.then(async () => {
    for (;;) {
      const now = Date.now();
      // Drop timestamps older than the 60s window.
      while (callTimestamps.length && now - callTimestamps[0] > 60_000) {
        callTimestamps.shift();
      }
      if (callTimestamps.length < RATE_LIMIT_PER_MINUTE) {
        callTimestamps.push(now);
        return;
      }
      // Wait until the oldest call ages out of the window.
      const waitMs = 60_000 - (now - callTimestamps[0]) + 20;
      await sleep(waitMs);
    }
  });
  gate = run.catch(() => {});
  return run;
}

/* --------------------------------------------------------------------------- *
 * Low-level request
 * --------------------------------------------------------------------------- */
const TRANSIENT = /ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|ECONNREFUSED|network|fetch failed/i;

class ZenotiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ZenotiError';
    this.status = status;
    this.body = body;
  }
}

function isConfigured() {
  return Boolean(API_KEY);
}

/**
 * Perform a Zenoti API request.
 * @param {string} path   e.g. "/v1/guests/search"
 * @param {object} opts   { method, query, body, timeoutMs, retries }
 */
async function request(path, opts = {}) {
  if (!isConfigured()) {
    throw new ZenotiError('Zenoti is not configured (missing ZENOTI_API_KEY)', 500);
  }

  const {
    method = 'GET',
    query,
    body,
    timeoutMs = 20_000,
    retries = 2,
  } = opts;

  const url = new URL(path.startsWith('http') ? path : `${ZENOTI_API_BASE}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
  }

  let attempt = 0;
  for (;;) {
    await acquireSlot();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url.toString(), {
        method,
        headers: {
          Authorization: `apikey ${API_KEY}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      clearTimeout(timer);

      // 429: back off honouring Retry-After, then retry.
      if (res.status === 429 && attempt < retries) {
        const retryAfter = Number(res.headers.get('retry-after')) || 2;
        logger.warn('Zenoti 429 throttled — backing off', { path, retryAfter });
        await sleep(retryAfter * 1000);
        attempt += 1;
        continue;
      }

      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }

      if (!res.ok) {
        const message =
          (json && (json.message || json.Message || (json.error && json.error.message))) ||
          `Zenoti request failed (${res.status})`;
        // Log without dumping any PII-bearing body.
        logger.error('Zenoti API error', { path, status: res.status, message });
        throw new ZenotiError(message, res.status, json);
      }

      return json;
    } catch (err) {
      clearTimeout(timer);
      const transient = TRANSIENT.test(err.name || '') || TRANSIENT.test(err.message || '') || err.name === 'AbortError';
      if (transient && attempt < retries) {
        const backoff = 500 * 2 ** attempt;
        logger.warn('Zenoti transient error — retrying', { path, attempt, error: err.message });
        await sleep(backoff);
        attempt += 1;
        continue;
      }
      if (err instanceof ZenotiError) throw err;
      throw new ZenotiError(err.message || 'Zenoti request failed', 0, null);
    }
  }
}

/* --------------------------------------------------------------------------- *
 * Normalisers — Zenoti → app shapes. Defensive about field name variants so a
 * minor schema difference between centres doesn't drop data.
 * --------------------------------------------------------------------------- */
const pick = (obj, ...keys) => {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return null;
};

/** Zenoti personal_info / guest → the app's user-ish profile shape. */
function normalizeGuest(raw) {
  if (!raw) return null;
  const info = raw.personal_info || raw.PersonalInfo || raw;
  const contact = info.mobile_phone || info.MobilePhone || {};
  // The full guest endpoint returns address_info at the root, while some list
  // responses nest it under personal_info. Support both; the old code only
  // handled the latter and silently discarded every full-profile address.
  const address = raw.address_info || raw.AddressInfo || info.address_info || info.AddressInfo || {};
  const centerId = pick(raw, 'center_id', 'CenterId') || pick(info, 'center_id', 'CenterId');

  const firstName = pick(info, 'first_name', 'FirstName') || '';
  const lastName = pick(info, 'last_name', 'LastName') || '';
  const mobile =
    normalizeIndianMobile(pick(contact, 'number', 'Number')) ||
    normalizeIndianMobile(pick(info, 'mobile_phone', 'phone'));

  return {
    zenotiGuestId: String(pick(raw, 'id', 'Id', 'guest_id') || '').toLowerCase() || null,
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`.trim(),
    email: pick(info, 'email', 'Email'),
    phone: mobile,
    // Prefer Zenoti's human-readable gender_name; fall back to the integer enum.
    gender: normalizeGender(pick(info, 'gender_name', 'gender', 'Gender')),
    dateOfBirth: pick(info, 'date_of_birth', 'DateOfBirth'),
    centerId,
    centerName: centerById(centerId)?.name || null,
    branchName: branchNameForCenter(centerId),
    code: pick(raw, 'code', 'Code'),
    preferredName: pick(info, 'preferred_name', 'PreferredName'),
    memberSince: pick(info, 'member_since', 'MemberSince'),
    anniversaryDate: pick(info, 'anniversary_date', 'AnniversaryDate'),
    isMinor: Boolean(info.is_minor),
    isVirtualGuest: Boolean(raw.is_virtual_guest),
    isOnlineBookingBlocked: Boolean(raw.is_online_booking_blocked),
    isClassBookingBlocked: Boolean(raw.is_class_booking_blocked),
    isBlockedForNoShow: Boolean(raw.is_blocked_for_no_show),
    preferredServiceId: pick(raw, 'preferred_service_id'),
    wellnessId: pick(raw, 'wellness_id'),
    preferences: raw.preferences || null,
    tags: raw.tags || null,
    referral: raw.referral || null,
    primaryEmployee: raw.primary_employee || null,
    guestPasses: raw.guest_passes || null,
    milestoneDetails: raw.guest_milestone_details || null,
    additionalDetails: raw.additional_details || null,
    emergencyContact: {
      firstName: pick(info, 'emergency_contact_first_name'),
      lastName: pick(info, 'emergency_contact_last_name'),
      phone: pick(info.emergency_contact_phone_number || {}, 'number'),
    },
    address: {
      line1: pick(address, 'address1', 'Address1'),
      line2: pick(address, 'address2', 'Address2'),
      city: pick(address, 'city', 'City'),
      state: pick(address, 'state_id', 'state', 'State'),
      zip: pick(address, 'zip_code', 'zip', 'ZipCode'),
    },
    createdDate: pick(raw, 'created_date', 'CreatedDate'),
    // Keep the raw record on the object (server-side only) for controllers that
    // want a field we didn't map. Never returned verbatim to the client.
    _raw: raw,
  };
}

/**
 * Zenoti returns appointments as GROUPS, each holding one or more
 * `appointment_services`. A group has no top-level service/time — those live per
 * service. We flatten to one entry per service, which is what a treatment-history
 * list wants to show. (Confirmed against the live API — see scripts/zenotiDiscover*.js)
 */
function normalizeAppointmentGroup(group) {
  if (!group) return [];
  const centerId = pick(group, 'center_id', 'CenterId');
  const centerName = centerById(centerId)?.name || null;
  const directServices = Array.isArray(group.appointment_services) ? group.appointment_services : [];
  const packageServices = (Array.isArray(group.appointment_packages) ? group.appointment_packages : [])
    .flatMap((pkg) => (Array.isArray(pkg.appointment_services) ? pkg.appointment_services : [])
      .map((svc) => ({ ...svc, _packageName: pick(pkg, 'name') })));
  const services = [...directServices, ...packageServices];
  if (!services.length) return [];

  return services.map((svc) => {
    const service = svc.service || {};
    const therapist = svc.therapist || {};
    const svcPrice = service.price || {};
    const room = svc.room || {};
    const equipment = svc.equipment || {};
    const invoice = group.invoice || {};
    return {
      id: pick(svc, 'appointment_id') || pick(group, 'appointment_group_id'),
      appointmentGroupId: pick(group, 'appointment_group_id'),
      appointmentSegmentId: pick(svc, 'appointment_segment_id'),
      invoiceId: pick(group, 'invoice_id'),
      invoiceItemId: pick(svc, 'invoice_item_id'),
      serviceId: pick(service, 'id'),
      serviceName: pick(service, 'name', 'display_name'),
      startTime: pick(svc, 'start_time'),
      endTime: pick(svc, 'end_time'),
      durationMinutes: service.duration ?? null,
      packageName: svc._packageName || null,
      therapistName: pick(therapist, 'display_name', 'nick_name'),
      roomName: pick(room, 'name', 'Name'),
      equipmentName: pick(equipment, 'name', 'Name'),
      status: svc.appointment_status ?? null,
      invoiceNumber: pick(invoice, 'no', 'invoice_number'),
      price: svcPrice.final ?? svcPrice.sales ?? (group.price && (group.price.final ?? group.price.sales)) ?? null,
      centerId,
      centerName,
      membershipApplied: Boolean(svc.is_membership_applied),
      hasServiceForm: Boolean(svc.has_service_form),
      feedbackSubmitted: Boolean(group.is_feedback_submitted),
      notes: pick(group, 'notes'),
    };
  });
}

/**
 * One row from GET /v1/appointments (the center appointment book).
 *
 * Unlike the guest-history endpoint this is already one row per service and it
 * contains the operational fields the reception/doctor panels need. Keeping a
 * normalised shape here lets the frequent poller and webhook reconciler share
 * the exact same idempotent Booking upsert.
 */
function normalizeCenterAppointment(raw, centerId) {
  if (!raw || raw.blockout || !raw.appointment_id || !raw.guest?.id) return null;
  const guest = raw.guest || {};
  const mobile = guest.mobile || {};
  const service = raw.service || {};
  const therapist = raw.therapist || {};
  const price = raw.price || {};
  const room = raw.room || {};
  const equipment = raw.equipment || {};

  const normalizedGuest = normalizeGuest({
    id: guest.id,
    center_id: centerId,
    personal_info: {
      first_name: guest.first_name,
      last_name: guest.last_name,
      email: guest.email,
      gender: guest.gender,
      mobile_phone: {
        number: mobile.number || mobile.display_number,
      },
    },
  });

  return {
    id: pick(raw, 'appointment_id'),
    appointmentGroupId: pick(raw, 'appointment_group_id'),
    appointmentSegmentId: pick(raw, 'appointment_segment_id'),
    invoiceId: pick(raw, 'invoice_id'),
    invoiceItemId: pick(raw, 'invoice_item_id'),
    serviceId: pick(service, 'id'),
    serviceName: pick(service, 'name'),
    serviceCategory: pick(service.category || {}, 'name'),
    serviceSubCategory: pick(service.sub_category || {}, 'name'),
    startTime: pick(raw, 'start_time'),
    startTimeUtc: pick(raw, 'start_time_utc'),
    endTime: pick(raw, 'end_time'),
    endTimeUtc: pick(raw, 'end_time_utc'),
    actualStartTime: pick(raw, 'actual_start_time'),
    actualCompletedTime: pick(raw, 'actual_completed_time'),
    checkinTime: pick(raw, 'checkin_time'),
    status: raw.status ?? null,
    progress: raw.progress ?? null,
    source: raw.source ?? raw.booking_source ?? null,
    notes: pick(raw, 'notes') || pick(raw, 'group_notes'),
    therapistId: pick(therapist, 'id'),
    therapistName: pick(therapist, 'display_name', 'nick_name') ||
      `${pick(therapist, 'first_name') || ''} ${pick(therapist, 'last_name') || ''}`.trim() || null,
    roomName: pick(room, 'name'),
    equipmentName: pick(equipment, 'name'),
    price: price.final ?? price.sales ?? null,
    invoiceNumber: pick(raw, 'invoice_number'),
    receiptNumber: pick(raw, 'receipt_number'),
    centerId,
    centerName: centerById(centerId)?.name || null,
    branchName: branchNameForCenter(centerId),
    guest: normalizedGuest,
    formId: pick(raw, 'form_id'),
    packageId: pick(raw, 'package_id'),
    packageName: pick(raw, 'package_name'),
    isPrescriptionSigned: raw.is_prescription_signed ?? null,
    hasUnexpiredPackages: Boolean(raw.has_unexpired_packages),
    membershipApplied: Boolean(raw.autoapply_membership || raw.has_active_membership_for_auto_pay),
    isStarted: Boolean(raw.is_started) || Number(raw.progress) === 1,
    isCompleted: Boolean(raw.is_completed) || Number(raw.progress) === 2,
    createdAt: pick(raw, 'creation_date'),
    updatedAt: pick(raw, 'last_date'),
  };
}

/** A single product purchase line from /guests/{id}/products. */
function normalizeProductPurchase(item) {
  if (!item) return null;
  return {
    id: pick(item, 'id', 'Id'),
    name: pick(item, 'name', 'Name'),
    quantity: item.quantity ?? null,
    saleDate: pick(item, 'sale_date', 'SaleDate'),
    price: item.price_paid ?? item.price ?? null,
    paymentType: pick(item, 'payment_type'),
    soldBy: pick(item, 'sale_by'),
    centerName: pick(item.center || {}, 'name', 'Name'),
    invoiceNumber: pick(item.invoice || {}, 'invoice_number', 'receipt_number'),
  };
}

/** A package the guest owns, with per-service session balances. */
function normalizePackage(p) {
  if (!p) return null;
  const services = (Array.isArray(p.services) ? p.services : []).map((s) => ({
    name: pick(s.service_type_info || {}, 'name', 'Name'),
    total: s.total ?? null,
    used: s.used ?? null,
    balance: s.balance ?? null,
  }));
  const sum = (key) => services.reduce((n, s) => n + (Number(s[key]) || 0), 0);
  const products = (Array.isArray(p.products) ? p.products : []).map((product) => ({
    name: pick(product.product_info || product.product || {}, 'name', 'Name'),
    total: product.total ?? null,
    used: product.used ?? null,
    balance: product.balance ?? null,
    balanceAmount: product.balance_amount ?? null,
  }));
  const date = p.date || {};
  const invoice = p.invoice || {};
  const redemption = p.redemption_setting_details || {};
  return {
    id: pick(p, 'user_package_id', 'id'),
    name: pick(p.package || {}, 'name', 'Name'),
    status: p.status ?? null, // numeric Zenoti code
    purchaseDate: pick(date, 'purchase_date'),
    startDate: pick(date, 'start'),
    endDate: p.never_expires ? null : pick(date, 'end'),
    neverExpires: Boolean(p.never_expires),
    price: p.purchase_price ?? null,
    centerName: pick(p.center || {}, 'name', 'Name'),
    redeemable: p.redeemable ?? null,
    invoice: {
      id: pick(invoice, 'id'),
      number: pick(invoice, 'no', 'invoice_number'),
      receiptNumber: pick(invoice, 'receipt_no', 'receipt_number'),
      status: invoice.status ?? null,
    },
    services,
    products,
    sessionsTotal: sum('total'),
    sessionsRemaining: sum('balance'),
    totalPayment: redemption.total_payment ?? p.purchase_price ?? null,
    isFrozen: Boolean(redemption.is_frozen),
    restrictRedemptionToCenter: Boolean(redemption.restrict_redemption_in_this_center),
  };
}

/** A membership the guest holds, with credit balance + per-service benefits. */
function normalizeMembership(m) {
  if (!m) return null;
  const services = (Array.isArray(m.services) ? m.services : []).map((s) => ({
    name: pick(s.service || {}, 'name', 'Name'),
    total: s.total ?? null,
    used: s.used ?? null,
    balance: s.balance ?? null,
    expiryDate: pick(s, 'expiry_date'),
  }));
  const products = (Array.isArray(m.products) ? m.products : []).map((p) => ({
    name: pick(p.product || p.product_info || {}, 'name', 'Name'),
    total: p.total ?? null,
    used: p.used ?? null,
    balance: p.balance ?? null,
    expiryDate: pick(p, 'expiry_date'),
  }));
  const invoice = m.invoice || {};
  return {
    id: pick(m, 'user_membership_id', 'id'),
    name: pick(m.membership || {}, 'name', 'Name'),
    code: pick(m.membership || {}, 'code') || pick(m, 'member_code'),
    status: m.status ?? null, // numeric Zenoti code
    memberSince: pick(m, 'member_since'),
    expiryDate: pick(m, 'expiry_date'),
    creditBalance: m.credit_balance ? (m.credit_balance.total ?? null) : null,
    centerName: centerById(pick(m, 'invoice_center_id'))?.name || null,
    services,
    products,
    isRefunded: Boolean(m.is_refunded),
    recurrenceStatus: m.recurrence_status ?? null,
    redeemable: m.redeemable ?? null,
    isAddonMember: Boolean(m.is_addon_member),
    guestPassType: m.guestpass_type ?? null,
    guestPassTotal: m.guestpass_total ?? null,
    guestPassBalance: m.guestpass_balance ?? null,
    htmlBenefits: m.html_benefits || null,
    invoice: {
      id: pick(invoice, 'id'),
      number: pick(invoice, 'no', 'invoice_number'),
      receiptNumber: pick(invoice, 'receipt_no', 'receipt_number'),
      status: invoice.status ?? null,
    },
    historicalInvoices: Array.isArray(m.historical_invoices) ? m.historical_invoices : [],
  };
}

/** A staff-visible guest note. Private notes are never requested. */
function normalizeGuestNote(n) {
  if (!n) return null;
  const creator = n.created_by || n.createdBy || {};
  const modifier = n.modified_by || n.modifiedBy || {};
  return {
    id: pick(n, 'id', 'note_id', 'guest_note_id'),
    text: pick(n, 'note', 'notes', 'text', 'description'),
    type: pick(n, 'note_type_name', 'type_name', 'type') ?? n.note_type ?? null,
    isPrivate: Boolean(n.is_private),
    isProfileAlert: Boolean(n.is_profile_alert),
    createdAt: pick(n, 'created_date', 'created_at') || pick(creator, 'date'),
    createdBy: pick(creator, 'name') || pick(n, 'created_by_name'),
    modifiedAt: pick(n, 'modified_date', 'modified_at') || pick(modifier, 'date'),
    modifiedBy: pick(modifier, 'name') || pick(n, 'modified_by_name'),
    centerName: pick(n.center || {}, 'name', 'Name'),
  };
}

/** Metadata for a form attached to the guest. Form contents remain in Zenoti. */
function normalizeGuestForm(f) {
  if (!f) return null;
  return {
    id: pick(f, 'form_id', 'id'),
    name: pick(f, 'name', 'form_name'),
    status: f.form_filled_status ?? f.filled_status ?? null,
    isExpired: Boolean(f.is_expired),
    lastFilledAt: pick(f, 'last_filled_date', 'lastfilled_date'),
    lastFilledBy: pick(f, 'last_filled_by', 'lastfilled_by'),
    formType: f.form_type ?? null,
    viewOnly: Boolean(f.viewonly ?? f.is_viewonly),
    formUrl: pick(f, 'form_url'),
    history: (Array.isArray(f.form_history) ? f.form_history : []).map((h) => ({
      versionId: pick(h, 'version_id'),
      versionDate: pick(h, 'version_date'),
      createdBy: pick(h, 'created_by'),
      formName: pick(h, 'form_name'),
      formUrl: pick(h, 'form_url'),
    })),
  };
}

/* --------------------------------------------------------------------------- *
 * Public API
 * --------------------------------------------------------------------------- */

/** GET /v1/centers — cached for an hour; centres rarely change. */
let centersCache = { at: 0, data: null };
async function getCenters() {
  if (centersCache.data && Date.now() - centersCache.at < 60 * 60 * 1000) {
    return centersCache.data;
  }
  const json = await request('/v1/centers');
  const centers = json.centers || json.Centers || [];
  centersCache = { at: Date.now(), data: centers };
  return centers;
}

/* ----------------------------- Catalog (cached) ---------------------------- */
// Services and products per centre, cached for an hour. Used by the write layer
// to resolve one of our consultations/products to its Zenoti catalog id.
const catalogCache = new Map(); // key -> { at, data }
const ONE_HOUR = 60 * 60 * 1000;

async function cachedPaged(key, fetchPage) {
  const hit = catalogCache.get(key);
  if (hit && Date.now() - hit.at < ONE_HOUR) return hit.data;
  const all = [];
  let page = 1;
  for (;;) {
    const items = await fetchPage(page);
    if (!items || items.length === 0) break;
    all.push(...items);
    if (items.length < 100) break; // last page
    page += 1;
    if (page > 20) break; // hard stop — safety
  }
  catalogCache.set(key, { at: Date.now(), data: all });
  return all;
}

/** All bookable services for a centre → [{ id, code, name }]. */
async function getCenterServices(centerId) {
  if (!centerId) return [];
  return cachedPaged(`services:${centerId}`, async (page) => {
    const json = await request(`/v1/centers/${centerId}/services`, {
      query: { page, size: 100 },
    });
    const list = json?.services || json?.Services || [];
    return list.map((s) => ({
      id: pick(s, 'id', 'Id'),
      code: pick(s, 'code', 'Code'),
      name: pick(s, 'name', 'Name'),
    }));
  });
}

/** All retail products for a centre → [{ id, code, name }]. */
async function getCenterProducts(centerId) {
  if (!centerId) return [];
  return cachedPaged(`products:${centerId}`, async (page) => {
    const json = await request(`/v1/centers/${centerId}/products`, {
      query: { page, size: 100 },
    });
    const list = json?.products || json?.Products || [];
    return list.map((p) => ({
      id: pick(p, 'id', 'Id'),
      code: pick(p, 'code', 'Code'),
      name: pick(p, 'name', 'Name'),
    }));
  });
}

/**
 * Find a guest by mobile number. Tries the bare 10-digit form first, then the
 * 91-prefixed form, since centres store numbers inconsistently.
 * @returns {Promise<object|null>} normalised guest, or null if not on Zenoti.
 */
async function findGuestByPhone(phone) {
  const ten = normalizeIndianMobile(phone) || String(phone || '').replace(/\D/g, '');
  if (!ten) return null;

  const variants = [ten, `91${ten}`];
  for (const variant of variants) {
    const json = await request('/v1/guests/search', { query: { phone: variant } });
    const guests = json?.guests || json?.Guests || [];
    if (guests.length > 0) {
      return normalizeGuest(guests[0]);
    }
  }
  return null;
}

/** Find a guest by email address. */
async function findGuestByEmail(email) {
  if (!email) return null;
  const json = await request('/v1/guests/search', { query: { email } });
  const guests = json?.guests || json?.Guests || [];
  return guests.length ? normalizeGuest(guests[0]) : null;
}

/**
 * One page of a centre's guest roster. Zenoti pages from 1 and caps `size` at
 * 100; `page_Info.total` is the centre-wide count.
 * @returns {{ guests: object[], total: number }}
 */
async function listCenterGuests(centerId, page = 1, size = 100) {
  const json = await request('/v1/guests', { query: { center_id: centerId, page, size } });
  const raw = json?.guests || json?.Guests || [];
  const info = json?.page_Info || json?.page_info || {};
  return { guests: raw.map(normalizeGuest).filter((g) => g && g.zenotiGuestId), total: Number(info.total) || raw.length };
}

/** GET /v1/guests/{id} — full guest profile. */
async function getGuest(guestId) {
  if (!guestId) return null;
  const json = await request(`/v1/guests/${guestId}`, {
    query: { expand: 'tags,address_info,preferences,referrals' },
  });
  return normalizeGuest(json);
}

/**
 * Appointment / treatment history for a guest across a date window.
 * Zenoti returns appointment GROUPS; we flatten to one entry per service and
 * sort newest first. Default window: last 3 years → next 3 months.
 */
async function getGuestAppointments(guestId, { from, to } = {}) {
  if (!guestId) return [];
  const start = from || process.env.ZENOTI_HISTORY_START_DATE || '2000-01-01';
  const end = to || isoDaysFromNow(90);
  const groups = [];
  for (let page = 1; page <= 500; page += 1) {
    const json = await request(`/v1/guests/${guestId}/appointments`, {
      query: { start_date: start, end_date: end, page, size: 100 },
    });
    const list = json?.appointments || json?.Appointments || [];
    groups.push(...list);
    const info = json?.page_info || json?.page_Info || {};
    if (!list.length || list.length < 100 || (info.total && groups.length >= Number(info.total))) break;
  }
  const flat = groups.flatMap(normalizeAppointmentGroup).filter(Boolean);
  // Newest first — Zenoti doesn't guarantee order.
  flat.sort((a, b) => new Date(b.startTime || 0) - new Date(a.startTime || 0));
  return flat;
}

/**
 * The working appointment book for one center and a window of at most 7 days.
 * This endpoint is intentionally used for the two-minute operational poll: it
 * is one request per clinic instead of one request per patient.
 */
async function getCenterAppointments(centerId, { from, to, includeCancelled = true } = {}) {
  if (!centerId) return [];
  const start = from || isoDaysFromNow(-1);
  const end = to || isoDaysFromNow(6);
  const json = await request('/v1/appointments', {
    query: {
      center_id: centerId,
      start_date: start,
      end_date: end,
      include_no_show_cancel: includeCancelled,
    },
  });
  const rows = Array.isArray(json) ? json : json?.appointments || json?.Appointments || [];
  return rows.map((row) => normalizeCenterAppointment(row, centerId)).filter(Boolean);
}

/**
 * One appointment by id (GET /v1/appointments/{id}) — the same operational
 * shape as the centre book, so a single visit can be re-read on demand or
 * double-checked before a terminal state from the feed is applied.
 */
async function getAppointment(appointmentId) {
  if (!appointmentId) return null;
  const json = await request(`/v1/appointments/${appointmentId}`);
  const raw = json?.appointment || json;
  if (!raw) return null;
  const centerId = pick(raw, 'center_id', 'CenterId') || pick(raw.center || {}, 'id');
  return normalizeCenterAppointment(raw, centerId);
}

/** Active employees assigned to a centre on the requested clinic date. */
async function getCenterEmployees(centerId, { date } = {}) {
  if (!centerId) return [];
  const all = [];
  for (let page = 1; page <= 100; page += 1) {
    const json = await request(`/v1/centers/${centerId}/employees`, {
      query: { date: date || isoDaysFromNow(0), page, size: 100 },
    });
    const rows = json?.employees || json?.Employees || [];
    all.push(...rows);
    const info = json?.page_info || json?.page_Info || {};
    if (!rows.length || rows.length < 100 || (info.total && all.length >= Number(info.total))) break;
  }
  return all.map((employee) => {
    const personal = employee.personal_info || employee.PersonalInfo || {};
    const job = employee.job_info || employee.JobInfo || {};
    const name = pick(personal, 'name') || `${pick(personal, 'first_name') || ''} ${pick(personal, 'last_name') || ''}`.trim() || pick(employee, 'name');
    return {
      id: String(pick(employee, 'id') || '').toLowerCase() || null,
      name,
      jobName: pick(job, 'name', 'job_name') || pick(employee, 'job_name'),
    };
  }).filter((employee) => employee.id && employee.name);
}

/** Product / retail purchase history for a guest. */
async function getGuestProducts(guestId) {
  if (!guestId) return [];
  const all = [];
  for (let page = 1; page <= 500; page += 1) {
    const json = await request(`/v1/guests/${guestId}/products`, { query: { page, size: 100 } });
    const list = json?.products || json?.Products || json?.items || [];
    all.push(...list);
    const info = json?.page_info || json?.page_Info || {};
    if (!list.length || list.length < 100 || (info.total && all.length >= Number(info.total))) break;
  }
  return all.map(normalizeProductPurchase).filter(Boolean);
}

/**
 * Membership(s) a guest holds. Zenoti's guest-memberships endpoint REQUIRES a
 * center_id (without it: 401 "Invalid Center") and returns them under
 * `guest_memberships`. Pass the guest's home center id.
 */
async function getGuestMemberships(guestId, centerId) {
  if (!guestId) return [];
  const json = await request(`/v1/guests/${guestId}/memberships`, {
    query: { center_id: centerId, is_active: -1, show_redeemable: true },
  });
  const list = json?.guest_memberships || json?.memberships || json?.Memberships || [];
  return list.map(normalizeMembership).filter(Boolean);
}

/**
 * Series / day packages a guest owns (their treatment package entitlements).
 * Zenoti returns a BARE array here (not wrapped in `.packages`).
 */
async function getGuestPackages(guestId) {
  if (!guestId) return [];
  const json = await request(`/v1/guests/${guestId}/packages`, {
    query: { page_num: -1, page_size: 0, show_redeemable: false },
  });
  const list = Array.isArray(json)
    ? json
    : json?.packages || json?.Packages || json?.series_packages || [];
  return list.map(normalizePackage).filter(Boolean);
}

/** All non-private notes visible to this API key, paged to completion. */
async function getGuestNotes(guestId) {
  if (!guestId) return [];
  const all = [];
  for (let page = 1; page <= 100; page += 1) {
    const json = await request(`/v1/guests/${guestId}/notes`, {
      query: { view_private: false, page, size: 100 },
    });
    const list = json?.notes || json?.Notes || [];
    all.push(...list.map(normalizeGuestNote).filter(Boolean));
    const info = json?.page_info || json?.page_Info || {};
    if (!list.length || list.length < 100 || (info.total && all.length >= Number(info.total))) break;
  }
  return all;
}

/** Guest-level form metadata, including version history when Zenoti exposes it. */
async function getGuestForms(guestId) {
  if (!guestId) return [];
  const json = await request(`/v1/guests/${guestId}/guest_forms`, { query: { expand: 'history' } });
  const list = Array.isArray(json) ? json : json?.forms || json?.guest_forms || [];
  return list.map(normalizeGuestForm).filter(Boolean);
}

function isoDaysFromNow(days) {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

module.exports = {
  isConfigured,
  ZenotiError,
  request,
  getCenters,
  getCenterServices,
  getCenterProducts,
  findGuestByPhone,
  findGuestByEmail,
  listCenterGuests,
  getGuest,
  getGuestAppointments,
  getCenterAppointments,
  getAppointment,
  getCenterEmployees,
  getGuestProducts,
  getGuestMemberships,
  getGuestPackages,
  getGuestNotes,
  getGuestForms,
  // exported for reuse/testing
  normalizeGuest,
  normalizeAppointmentGroup,
  normalizeCenterAppointment,
  normalizeProductPurchase,
  normalizePackage,
  normalizeMembership,
  normalizeGuestNote,
  normalizeGuestForm,
};
