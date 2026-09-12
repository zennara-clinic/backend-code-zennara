/**
 * A dermatologist's patients: every guest they have ever been booked with,
 * one row per guest.
 *
 * Grouped in Mongo, not in the panel. An established dermatologist has 1,000 to
 * 7,000 bookings (prod, 2026-09-10). The panel used to download all of them to
 * count guests in the browser, which showed "0 under your care" while the
 * request was in flight and stayed empty when it failed.
 */
const Booking = require('../models/Booking');
const Consultation = require('../models/Consultation');
const { UPCOMING } = require('./bookingStatuses');
const { clinicDayStart } = require('./bookingTime');
const { guestCodeOf } = require('./guestCode');

const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The bookings that belong to this dermatologist.
 *
 * Their profile id, and their Zenoti employee id: a visit synced from Zenoti
 * before the profile was linked carries only the employee id (on prod, every
 * booking of the inactive profiles is like that). A Zenoti visit that was
 * reassigned to a different dermatologist here keeps its employee id, so the
 * employee-id path only takes rows with no other local owner — nobody's visit
 * shows in two diaries.
 */
function doctorBookingMatch(doctor) {
  const id = String(doctor?.doctorId || '').toLowerCase().trim();
  const emp = String(doctor?.zenotiEmployeeId || '').toLowerCase().trim();
  if (!id && !emp) return { _id: { $exists: false } };
  const or = [];
  if (id) or.push({ specialistId: id });
  if (emp) or.push({ zenotiTherapistId: emp, specialistId: { $in: id ? [null, '', id] : [null, ''] } });
  return or.length === 1 ? or[0] : { $or: or };
}

const SORTS = {
  // Last time they were in (or, for a guest only booked ahead, that booking).
  recent: { recency: -1, _id: 1 },
  name: { sortName: 1, _id: 1 },
  next: { hasNext: -1, nextVisit: 1, recency: -1, _id: 1 },
  visits: { visits: -1, recency: -1, _id: 1 },
};

/**
 * @param doctor  a Doctor document (needs doctorId, optionally zenotiEmployeeId)
 * @param params  { search, filter: all|booked|unbooked, sort: recent|name|next|visits, page, limit }
 */
async function listDoctorPatients(doctor, params = {}) {
  const limit = Math.min(100, Math.max(1, parseInt(params.limit, 10) || 30));
  const page = Math.max(1, parseInt(params.page, 10) || 1);
  const search = String(params.search || '').trim().slice(0, 80);
  const filter = ['booked', 'unbooked'].includes(params.filter) ? params.filter : 'all';
  const sort = SORTS[params.sort] || SORTS.recent;
  const now = new Date();
  const todayStart = clinicDayStart(now);
  const onlyFilter = filter === 'booked' ? [{ $match: { hasNext: 1 } }] : filter === 'unbooked' ? [{ $match: { hasNext: 0 } }] : [];
  const rx = search ? new RegExp(escapeRx(search), 'i') : null;

  const [out] = await Booking.aggregate([
    { $match: { $and: [doctorBookingMatch(doctor), { userId: { $ne: null } }] } },
    {
      $project: {
        userId: 1, status: 1, fullName: 1, consultationId: 1, externalServiceName: 1,
        at: { $ifNull: ['$eventAt', { $ifNull: ['$confirmedDate', '$preferredDate'] }] },
      },
    },
    { $sort: { at: -1 } },
    {
      $group: {
        _id: '$userId',
        bookingName: { $first: '$fullName' },
        bookings: { $sum: 1 },
        visits: { $sum: { $cond: [{ $eq: ['$status', 'Completed'] }, 1, 0] } },
        lastVisit: { $max: { $cond: [{ $eq: ['$status', 'Completed'] }, '$at', null] } },
        // Last time they were booked in (a cancellation is not a visit), up to now.
        lastSeen: { $max: { $cond: [{ $and: [{ $lte: ['$at', now] }, { $ne: ['$status', 'Cancelled'] }] }, '$at', null] } },
        nextVisit: { $min: { $cond: [{ $and: [{ $in: ['$status', UPCOMING] }, { $gte: ['$at', todayStart] }] }, '$at', null] } },
        consultationIds: { $addToSet: '$consultationId' },
        serviceNames: { $addToSet: '$externalServiceName' },
      },
    },
    // A guest whose account was deleted has no record to open; leave them out.
    { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'u' } },
    { $match: { 'u.0': { $exists: true } } },
    { $addFields: { u: { $arrayElemAt: ['$u', 0] } } },
    {
      $project: {
        bookingName: 1, bookings: 1, visits: 1, lastVisit: 1, lastSeen: 1, nextVisit: 1, consultationIds: 1, serviceNames: 1,
        'u.fullName': 1, 'u.phone': 1, 'u.patientId': 1, 'u.guestCode': 1, 'u.email': 1, 'u.gender': 1, 'u.dateOfBirth': 1,
        'u.drugAllergies': 1, 'u.hasDrugAllergy': 1, 'u.memberType': 1,
      },
    },
    {
      $addFields: {
        fullName: { $ifNull: ['$u.fullName', '$bookingName'] },
        hasNext: { $cond: [{ $gt: ['$nextVisit', null] }, 1, 0] },
        recency: { $ifNull: ['$lastSeen', '$nextVisit'] },
      },
    },
    ...(rx ? [{ $match: { $or: [{ fullName: rx }, { bookingName: rx }, { 'u.phone': rx }, { 'u.patientId': rx }, { 'u.guestCode': rx }, { 'u.email': rx }] } }] : []),
    { $addFields: { sortName: { $toLower: { $ifNull: ['$fullName', ''] } } } },
    {
      $facet: {
        counts: [{ $group: { _id: null, all: { $sum: 1 }, booked: { $sum: '$hasNext' } } }],
        total: [...onlyFilter, { $count: 'n' }],
        rows: [...onlyFilter, { $sort: sort }, { $skip: (page - 1) * limit }, { $limit: limit }],
      },
    },
  ]).allowDiskUse(true);

  const rows = out?.rows || [];
  const ids = [...new Set(rows.flatMap((r) => (r.consultationIds || []).filter(Boolean).map(String)))];
  const serviceName = ids.length
    ? new Map((await Consultation.find({ _id: { $in: ids } }).select('name').lean()).map((c) => [String(c._id), c.name]))
    : new Map();
  const counts = out?.counts?.[0] || { all: 0, booked: 0 };
  const total = out?.total?.[0]?.n || 0;

  return {
    total,
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit)),
    counts: { all: counts.all, booked: counts.booked, unbooked: counts.all - counts.booked },
    data: rows.map((r) => {
      const allergy = String(r.u?.drugAllergies || '').trim();
      return {
        userId: r._id,
        fullName: r.fullName || 'Guest',
        phone: r.u?.phone || null,
        patientId: guestCodeOf(r.u),
        guestCode: r.u?.guestCode || null,
        gender: r.u?.gender || null,
        dateOfBirth: r.u?.dateOfBirth || null,
        memberType: r.u?.memberType || null,
        drugAllergy: allergy && !/^(none|no|nil|na|n\/a)\.?$/i.test(allergy) ? allergy : (r.u?.hasDrugAllergy ? 'Drug allergy' : null),
        bookings: r.bookings,
        visits: r.visits,
        lastVisit: r.lastVisit || null,
        lastBooked: r.lastSeen || null,
        nextVisit: r.nextVisit || null,
        services: [...new Set([
          ...(r.consultationIds || []).map((id) => serviceName.get(String(id))),
          ...(r.serviceNames || []),
        ].filter(Boolean))].slice(0, 6),
      };
    }),
  };
}

module.exports = { doctorBookingMatch, listDoctorPatients };
