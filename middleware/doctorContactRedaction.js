/**
 * A dermatologist never sees how to reach a guest.
 *
 * Every JSON response to a login with role 'doctor' has guest contact fields
 * removed — phone numbers and email addresses, wherever they sit in the
 * payload (the guest record, a booking, a pre-consult form, a consent form,
 * the Zenoti copy, an order's shipping address). The clinic's decision
 * (2026-09-10): contact belongs to the desk, not the consult room.
 *
 * Done once, at the response, rather than per controller: the panel reads
 * guests through a dozen endpoints and any new one would otherwise leak by
 * default. A hidden field in the panel is not a privacy control.
 *
 * Exempt: the dermatologist's own sign-in and profile, which carry their own
 * email and phone (login, "my account", the Doctor profile). The patients list
 * under /doctors/me/patients is guest data and is NOT exempt.
 *
 * Every other role passes through untouched.
 */

const CONTACT_KEYS = new Set([
  'phone', 'email', 'mobileNumber', 'phoneNumber', 'mobile', 'mobilePhone',
  'alternatePhone', 'alternateMobile', 'whatsappNumber', 'contactPhone', 'contactEmail',
  // raw Zenoti shapes
  'mobile_phone', 'MobilePhone', 'home_phone', 'work_phone', 'Email',
]);

const EXEMPT = [
  /^\/api\/admin\/auth(\/|$)/,
  /^\/api\/doctors(?!\/me\/patients)(\/|$)/,
  /^\/api\/doctor-fee-requests(\/|$)/,
];

const isDoctor = (req) => req.admin?.role === 'doctor';
const isExempt = (req) => {
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  return EXEMPT.some((rx) => rx.test(path));
};

function withoutContact(key, value) {
  return CONTACT_KEYS.has(key) ? undefined : value;
}

function doctorContactRedaction(req, res, next) {
  const json = res.json.bind(res);
  // req.admin is set later, by the route's auth guard — so decide when the
  // handler answers, not now.
  res.json = function redactedJson(body) {
    if (!isDoctor(req) || isExempt(req)) return json(body);
    const text = JSON.stringify(body, withoutContact);
    if (!res.get('Content-Type')) res.set('Content-Type', 'application/json');
    return res.send(text);
  };
  next();
}

module.exports = doctorContactRedaction;
module.exports.CONTACT_KEYS = CONTACT_KEYS;
module.exports.isExempt = isExempt;
