/**
 * A dermatologist sees their own patients, and nobody else's.
 *
 * "Their patient" = a guest with at least one booking in their diary, past or
 * upcoming — by profile id or Zenoti employee id, the same rule as the diary
 * itself (utils/doctorPatients.doctorBookingMatch). Once a guest is theirs the
 * whole clinical record opens, including visits with other practitioners:
 * that history is what they treat from.
 *
 * Enforced here, at the route, because the panel only ever asks for guests it
 * already lists — a hidden button is not a privacy control. Every guard is a
 * no-op for any login that is not role 'doctor', so the admin and therapist
 * panels are untouched.
 */
const mongoose = require('mongoose');
const Booking = require('../models/Booking');
const { resolveDoctorForAdmin } = require('./doctorIdentity');
const { doctorBookingMatch } = require('./doctorPatients');

const isDoctor = (req) => req.admin?.role === 'doctor';
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || '')) && /^[a-f0-9]{24}$/i.test(String(v));
const idOf = (v) => (v && typeof v === 'object' && v._id ? String(v._id) : v ? String(v) : null);

const NOT_YOURS = {
  success: false,
  code: 'NOT_YOUR_PATIENT',
  message: 'This guest is not under your care.',
};
const deny = (res) => res.status(403).json(NOT_YOURS);

/** The Doctor profile behind this login, looked up once per request. */
async function myDoctor(req) {
  if (req._scopeDoctor === undefined) {
    req._scopeDoctor = await resolveDoctorForAdmin(req).catch(() => null);
  }
  return req._scopeDoctor;
}

/** Has this dermatologist ever been booked with this guest? Cached per request. */
async function isMyGuest(req, userId) {
  const key = idOf(userId);
  if (!isId(key)) return false;
  req._scopeGuests = req._scopeGuests || new Map();
  if (req._scopeGuests.has(key)) return req._scopeGuests.get(key);
  const doctor = await myDoctor(req);
  const mine = !!doctor && !!(await Booking.exists({ $and: [doctorBookingMatch(doctor), { userId: key }] }));
  req._scopeGuests.set(key, mine);
  return mine;
}

/** A booking in their diary, or any booking of a guest who is theirs. */
async function isMyBooking(req, bookingId) {
  const key = idOf(bookingId);
  if (!isId(key)) return false;
  const doctor = await myDoctor(req);
  if (!doctor) return false;
  const booking = await Booking.findById(key).select('userId').lean();
  if (!booking) return null; // let the handler answer its own 404
  if (await Booking.exists({ $and: [{ _id: key }, doctorBookingMatch(doctor)] })) return true;
  return isMyGuest(req, booking.userId);
}

/** Every guest id in their diary — for the few lists that search across guests. */
async function myGuestIds(req) {
  const doctor = await myDoctor(req);
  if (!doctor) return [];
  return Booking.distinct('userId', { $and: [doctorBookingMatch(doctor), { userId: { $ne: null } }] });
}

const wrap = (fn) => async (req, res, next) => {
  if (!isDoctor(req)) return next();
  try {
    return await fn(req, res, next);
  } catch (error) {
    console.error('doctorGuestScope failed:', error);
    return res.status(500).json({ success: false, message: 'Could not check access to this guest' });
  }
};

/** The guest named by `pick(req)` must be theirs. */
const ownGuest = (pick) => wrap(async (req, res, next) => {
  const userId = pick(req);
  if (!userId) return res.status(400).json({ success: false, message: 'A guest is required' });
  return (await isMyGuest(req, userId)) ? next() : deny(res);
});

/** The booking named by `pick(req)` must be theirs (a 404 is left to the handler). */
const ownBooking = (pick) => wrap(async (req, res, next) => {
  const bookingId = pick(req);
  if (!isId(bookingId)) return next();
  const mine = await isMyBooking(req, bookingId);
  return mine === false ? deny(res) : next();
});

/**
 * A stored record (by :id) must belong to one of their guests. `field` is the
 * guest reference on the model; a record with no guest falls back to its booking.
 */
const ownRecord = (Model, { param = 'id', field = 'userId', bookingField = 'bookingId' } = {}) => wrap(async (req, res, next) => {
  const id = req.params[param];
  if (!isId(id)) return next();
  const doc = await Model.findById(id).select(`${field} ${bookingField}`).lean();
  if (!doc) return next();
  if (doc[field]) return (await isMyGuest(req, doc[field])) ? next() : deny(res);
  if (doc[bookingField]) return (await isMyBooking(req, doc[bookingField])) === false ? deny(res) : next();
  return deny(res);
});

/**
 * A list read. A dermatologist must narrow it to one of their guests
 * (?userId=) or bookings (?bookingId=); `doctorKey` lists (notes) may instead
 * be narrowed to their own work, which is forced to their own id. An
 * unnarrowed list would be every guest in the clinic, so it is refused.
 */
const scopedList = ({ userKey = 'userId', bookingKey = 'bookingId', doctorKey = null } = {}) => wrap(async (req, res, next) => {
  const q = req.query || {};
  if (q[userKey]) return (await isMyGuest(req, q[userKey])) ? next() : deny(res);
  if (bookingKey && q[bookingKey]) return (await isMyBooking(req, q[bookingKey])) === false ? deny(res) : next();
  if (doctorKey && q[doctorKey]) {
    const doctor = await myDoctor(req);
    if (!doctor) return deny(res);
    req.query[doctorKey] = doctor.doctorId;
    return next();
  }
  return res.status(403).json({ ...NOT_YOURS, message: 'Choose one of your guests first.' });
});

/** When a list is optionally narrowed to a guest, that guest must be theirs. */
const ownGuestIfNamed = (key = 'userId') => wrap(async (req, res, next) => {
  const userId = req.query?.[key];
  if (!userId) return next();
  return (await isMyGuest(req, userId)) ? next() : deny(res);
});

/** Hands the handler their guest ids (req.doctorGuestIds) to filter a cross-guest search. */
const attachMyGuestIds = () => wrap(async (req, _res, next) => {
  req.doctorGuestIds = await myGuestIds(req);
  return next();
});

/** Clinic-wide reads and desk actions a dermatologist login never needs. */
const notForDoctors = wrap(async (_req, res) => res.status(403).json({
  success: false,
  code: 'NOT_FOR_DERMATOLOGISTS',
  message: 'This is not available from the dermatologist panel.',
}));

module.exports = {
  isDoctor,
  isMyGuest,
  isMyBooking,
  myGuestIds,
  ownGuest,
  ownBooking,
  ownRecord,
  scopedList,
  ownGuestIfNamed,
  attachMyGuestIds,
  notForDoctors,
};
