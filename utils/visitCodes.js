/**
 * Check-in / check-out codes.
 *
 * One 6-digit code per stage, stored in plain text on the booking. The guest
 * sees it in the app; reception enters it. For guests who don't use the app,
 * the same code goes out by email + WhatsApp:
 *   - check-in code: one hour before the slot (scheduler) or on demand
 *   - check-out code: the moment the session starts (check-in) or on demand
 */
const emailService = require('./emailService');
const whatsappService = require('../services/whatsappService');

const gen = () => String(Math.floor(100000 + Math.random() * 900000));
const isPlaceholderEmail = (e) => !e || /@guest\.zennara\.in$|@zennara\.local$/i.test(e);

/** Make sure the booking has a code for `kind`; returns { code, fresh }. */
function ensureCode(booking, kind) {
  const isOut = kind === 'checkout' || kind === 'check-out';
  const field = isOut ? 'checkOutCode' : 'checkInCode';
  const at = isOut ? 'checkOutCodeAt' : 'checkInCodeAt';
  if (booking[field]) return { code: booking[field], fresh: false };
  booking[field] = gen();
  booking[at] = new Date();
  return { code: booking[field], fresh: true };
}

/**
 * Deliver the code on the requested channels. Never throws; returns
 * { delivered: [...], failed: [{channel, reason}] } and records it on the booking
 * (caller saves).
 */
async function deliver(booking, kind, { channels = ['email', 'whatsapp'], by = null } = {}) {
  const isOut = kind === 'checkout' || kind === 'check-out';
  const label = isOut ? 'check-out' : 'check-in';
  const { code } = ensureCode(booking, kind);
  const delivered = [];
  const failed = [];
  const treatment = booking.consultationId && booking.consultationId.name ? booking.consultationId.name : booking.externalServiceName;

  if (channels.includes('email')) {
    if (isPlaceholderEmail(booking.email)) failed.push({ channel: 'email', reason: 'No email on file for this guest' });
    else {
      try {
        await emailService.sendVisitCodeEmail(booking.email, booking.fullName, {
          code, kind: label, referenceNumber: booking.referenceNumber, treatment, location: booking.preferredLocation,
        });
        delivered.push('email');
      } catch (e) { failed.push({ channel: 'email', reason: e.message }); }
    }
  }
  if (channels.includes('whatsapp')) {
    if (!booking.mobileNumber) failed.push({ channel: 'whatsapp', reason: 'No mobile number on file' });
    else {
      try {
        const tail = isOut ? 'to complete your visit' : 'to check in';
        const r = await whatsappService.sendMessage(booking.mobileNumber, `Your Zennara ${label} code is ${code}. Show it at reception ${tail}. (Ref ${booking.referenceNumber})`);
        if (r && r.success === false) failed.push({ channel: 'whatsapp', reason: r.error || 'WhatsApp send failed' });
        else delivered.push('whatsapp');
      } catch (e) { failed.push({ channel: 'whatsapp', reason: e.message }); }
    }
  }

  booking.visitCodeLog = booking.visitCodeLog || [];
  booking.visitCodeLog.push({
    kind: isOut ? 'checkout' : 'checkin', channels: delivered, failed: failed.map((f) => f.channel), at: new Date(),
    by: by && by._id ? by._id : null, byName: by && by.name ? by.name : (by === null ? 'system' : null),
  });
  if (delivered.length) booking[isOut ? 'checkOutCodeSentAt' : 'checkInCodeSentAt'] = new Date();
  return { code, delivered, failed };
}

module.exports = { gen, ensureCode, deliver, isPlaceholderEmail };
