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
  const address = info.address_info || info.AddressInfo || {};
  const centerId = pick(raw, 'center_id', 'CenterId') || pick(info, 'center_id', 'CenterId');

  const firstName = pick(info, 'first_name', 'FirstName') || '';
  const lastName = pick(info, 'last_name', 'LastName') || '';
  const mobile =
    normalizeIndianMobile(pick(contact, 'number', 'Number')) ||
    normalizeIndianMobile(pick(info, 'mobile_phone', 'phone'));

  return {
    zenotiGuestId: pick(raw, 'id', 'Id', 'guest_id'),
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
  const services = Array.isArray(group.appointment_services) ? group.appointment_services : [];
  if (!services.length) return [];

  return services.map((svc) => {
    const service = svc.service || {};
    const therapist = svc.therapist || {};
    const svcPrice = service.price || {};
    return {
      id: pick(svc, 'appointment_id') || pick(group, 'appointment_group_id'),
      invoiceId: pick(group, 'invoice_id'),
      serviceName: pick(service, 'name', 'display_name'),
      startTime: pick(svc, 'start_time'),
      endTime: pick(svc, 'end_time'),
      durationMinutes: service.duration ?? null,
      therapistName: pick(therapist, 'display_name', 'nick_name'),
      price: svcPrice.final ?? svcPrice.sales ?? (group.price && (group.price.final ?? group.price.sales)) ?? null,
      centerId,
      centerName,
      membershipApplied: Boolean(svc.is_membership_applied),
      notes: pick(group, 'notes'),
    };
  });
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
  const date = p.date || {};
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
    services,
    sessionsTotal: sum('total'),
    sessionsRemaining: sum('balance'),
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
  const json = await request(`/v1/guests/${guestId}`);
  return normalizeGuest(json);
}

/**
 * Appointment / treatment history for a guest across a date window.
 * Zenoti returns appointment GROUPS; we flatten to one entry per service and
 * sort newest first. Default window: last 3 years → next 3 months.
 */
async function getGuestAppointments(guestId, { from, to } = {}) {
  if (!guestId) return [];
  const start = from || isoDaysFromNow(-1095);
  const end = to || isoDaysFromNow(90);
  const json = await request(`/v1/guests/${guestId}/appointments`, {
    query: { start_date: start, end_date: end },
  });
  const groups = json?.appointments || json?.Appointments || [];
  const flat = groups.flatMap(normalizeAppointmentGroup).filter(Boolean);
  // Newest first — Zenoti doesn't guarantee order.
  flat.sort((a, b) => new Date(b.startTime || 0) - new Date(a.startTime || 0));
  return flat;
}

/** Product / retail purchase history for a guest. */
async function getGuestProducts(guestId) {
  if (!guestId) return [];
  const json = await request(`/v1/guests/${guestId}/products`);
  const list = json?.products || json?.Products || json?.items || [];
  return list.map(normalizeProductPurchase).filter(Boolean);
}

/**
 * Membership(s) a guest holds. Zenoti's guest-memberships endpoint REQUIRES a
 * center_id (without it: 401 "Invalid Center") and returns them under
 * `guest_memberships`. Pass the guest's home center id.
 */
async function getGuestMemberships(guestId, centerId) {
  if (!guestId) return [];
  const json = await request(`/v1/guests/${guestId}/memberships`, {
    query: { center_id: centerId },
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
  const json = await request(`/v1/guests/${guestId}/packages`);
  const list = Array.isArray(json)
    ? json
    : json?.packages || json?.Packages || json?.series_packages || [];
  return list.map(normalizePackage).filter(Boolean);
}

function isoDaysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
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
  getGuestProducts,
  getGuestMemberships,
  getGuestPackages,
  // exported for reuse/testing
  normalizeGuest,
  normalizeAppointmentGroup,
  normalizeProductPurchase,
  normalizePackage,
  normalizeMembership,
};
