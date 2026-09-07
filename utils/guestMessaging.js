/**
 * One place that decides whether WE send a guest message, and builds the
 * placeholder set templates use.
 *
 * Why: IT Zennara runs Zenoti's ezConnect, which already sends WhatsApp
 * confirmations / reminders / thank-yous for appointments booked in Zenoti.
 * If we also send, the guest gets two of everything. Per centre the desk can
 * say "Zenoti sends guest messages" — then our automatic WhatsApp for
 * Zenoti-sourced bookings is suppressed (desk-typed replies still go). App and
 * desk bookings, which Zenoti's ezConnect does not know about until mirrored,
 * always get ours.
 */
const Branch = require('../models/Branch');

const cache = new Map(); // branchId → { at, value }
const TTL = 60 * 1000;

async function branchMessaging(branchId, branchName) {
  const key = String(branchId || branchName || 'none');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  let b = null;
  try {
    if (branchId) b = await Branch.findById(branchId).select('messaging name contact').lean();
    else if (branchName) b = await Branch.findOne({ name: branchName }).select('messaging name contact').lean();
  } catch { /* fall through */ }
  const value = { zenotiSendsGuestMessages: !!b?.messaging?.zenotiSendsGuestMessages, whatsappEnabled: b?.messaging?.whatsappEnabled !== false, name: b?.name || branchName || null, phone: Array.isArray(b?.contact?.phone) ? b.contact.phone[0] : b?.contact?.phone || null };
  cache.set(key, { at: Date.now(), value });
  return value;
}

/**
 * Should our automatic WhatsApp go out for this booking?
 * `kind` is the message family ('confirmation' | 'reminder' | 'checkin' | 'completed' | 'noshow' | 'cancelled' | 'rescheduled' | 'code').
 */
async function shouldSendBookingWhatsApp(booking, kind = 'generic') {
  if (!booking) return { ok: false, reason: 'no booking' };
  const m = await branchMessaging(booking.branchId, booking.preferredLocation);
  if (!m.whatsappEnabled) return { ok: false, reason: 'whatsapp disabled for centre' };
  // Check-in / check-out codes are ours alone — Zenoti has no equivalent — so they always go.
  if (kind === 'code') return { ok: true };
  if (m.zenotiSendsGuestMessages && (booking.source === 'zenoti' || booking.zenotiAppointmentId)) return { ok: false, reason: 'Zenoti (ezConnect) sends messages for this centre' };
  return { ok: true };
}

/** Placeholder values for a template, from whatever context is at hand. */
async function templateVars({ user = null, booking = null, branch = null, invoice = null, assignment = null, membership = null, staffName = null } = {}) {
  const m = branch ? { name: branch.name, phone: Array.isArray(branch.contact?.phone) ? branch.contact.phone[0] : branch.contact?.phone } : await branchMessaging(booking?.branchId, booking?.preferredLocation);
  const name = user?.fullName || booking?.fullName || invoice?.guest?.name || '';
  const when = booking ? new Date(booking.confirmedDate || booking.preferredDate) : null;
  return {
    guestName: name, firstName: name.split(' ')[0] || '', phone: user?.phone || booking?.mobileNumber || invoice?.guest?.phone || '',
    centre: m.name || '', centrePhone: m.phone || '',
    service: booking?.consultationId?.name || booking?.externalServiceName || '', date: when ? when.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '',
    time: booking?.confirmedTime || booking?.preferredTimeSlots?.[0] || '', doctor: booking?.specialistName || '', reference: booking?.referenceNumber || '',
    amountDue: invoice ? `₹${(invoice.totals?.due || 0).toLocaleString('en-IN')}` : booking && booking.paymentStatus !== 'paid' ? `₹${(booking.amount || 0).toLocaleString('en-IN')}` : '₹0',
    staff: staffName || '', invoiceNumber: invoice?.invoiceNumber || '',
    packageName: assignment?.packageDetails?.packageName || '', sessionsLeft: assignment ? String(assignment.serviceBalances ? assignment.serviceBalances().reduce((n, r) => n + r.balance, 0) : '') : '', expiry: assignment?.validUntil ? new Date(assignment.validUntil).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }) : '',
    memberNumber: membership?.memberNumber || '',
  };
}

module.exports = { shouldSendBookingWhatsApp, branchMessaging, templateVars };
