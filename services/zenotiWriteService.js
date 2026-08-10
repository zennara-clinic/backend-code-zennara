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
    const date = (booking.confirmedDate || booking.preferredDate || new Date())
      .toISOString()
      .slice(0, 10);

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
    const slotTime =
      (slots[0] && (slots[0].Time || slots[0].time)) || `${date}T10:00:00`;

    await zenoti.request(`/v1/bookings/${zBookingId}/slots/reserve`, {
      method: 'POST',
      body: { slot_time: slotTime },
    });
    const confirmed = await zenoti.request(`/v1/bookings/${zBookingId}/slots/confirm`, {
      method: 'POST',
      body: { notes: payload.notes },
    });

    booking.zenotiAppointmentId =
      confirmed?.invoice_id || confirmed?.appointment_id || zBookingId;
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
  ensureGuest,
  syncBooking,
  syncOrder,
  resolveServiceId,
  resolveProductId,
};
