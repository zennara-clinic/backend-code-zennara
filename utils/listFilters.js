/**
 * Shared filter builders for the panel's listing pages (Patients, Bookings).
 *
 * Both the paged list endpoints and the export endpoints call these so a CSV
 * always contains exactly what the staff member filtered on screen.
 */
const Booking = require('../models/Booking');
const Consultation = require('../models/Consultation');
const User = require('../models/User');
const ZenotiPractitioner = require('../models/ZenotiPractitioner');
const { canonicalName } = require('./dermatologistMatch');
const { clinicDayEnd, clinicDayStart } = require('./bookingTime');

const escapeRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const list = (v) => (v === undefined || v === null || v === '' ? [] : Array.isArray(v) ? v : String(v).split(',')).map((x) => String(x).trim()).filter(Boolean);
const num = (v) => (v === undefined || v === '' || v === null || Number.isNaN(Number(v)) ? null : Number(v));
const dayStart = (v) => (v ? clinicDayStart(v) : null);
const dayEnd = (v) => (v ? clinicDayEnd(v) : null);
const isoDate = (d) => d.toISOString().slice(0, 10);

const practitionerNameRx = (name) => {
  const parts = canonicalName(name).split(' ').filter(Boolean);
  if (!parts.length) return /^$/;
  return new RegExp(`^\\s*(?:dr\\.?\\s*)?${parts.map(escapeRx).join('[^a-z0-9]+')}[^a-z0-9]*$`, 'i');
};

/** Translate the unified practitioner filter values into Booking fields.
 * Local/onboarded doctors use `specialistId`; reporting-only Zenoti doctors
 * use the immutable employee id, with a name fallback for historical rows. */
async function practitionerBookingMatch(raw) {
  const values = list(raw);
  const localIds = values.filter((value) => !value.startsWith('zenoti:') && !value.startsWith('zenoti-name:')).map((value) => value.toLowerCase());
  const employeeIds = values.filter((value) => value.startsWith('zenoti:')).map((value) => value.slice('zenoti:'.length).toLowerCase()).filter(Boolean);
  const historicalNames = values.filter((value) => value.startsWith('zenoti-name:')).map((value) => value.slice('zenoti-name:'.length)).filter(Boolean);
  const or = [];

  if (localIds.length) or.push({ specialistId: { $in: localIds } });
  if (employeeIds.length) or.push({ zenotiTherapistId: { $in: employeeIds } });

  // Existing appointments may predate the employee-id field. Resolve current
  // roster names as a compatibility path until the repair/backfill has run.
  if (employeeIds.length) {
    const practitioners = await ZenotiPractitioner.find({ zenotiEmployeeId: { $in: employeeIds } }).select('name').lean();
    historicalNames.push(...practitioners.map((row) => row.name));
  }
  historicalNames.forEach((name) => {
    const rx = practitionerNameRx(name);
    or.push({ $or: [{ specialistName: rx }, { zenotiTherapistName: rx }, { therapistName: rx }] });
  });

  if (!or.length) return { _id: { $exists: false } };
  return or.length === 1 ? or[0] : { $or: or };
}

/**
 * Dermatologist consultations vs treatments. Mirrors the app's
 * `isConsultationEntry` rule (category "Consultation(s)" or a name containing
 * "consultation") so the panel and the app agree on what a "consultation" is.
 */
const CONSULT_RX = /consult|counsel/i;
async function consultationIdsByKind() {
  const all = await Consultation.find({}).select('_id name category').lean();
  const consult = [];
  const treat = [];
  for (const c of all) {
    (/^consultations?$/i.test(c.category || '') || CONSULT_RX.test(c.name || '') ? consult : treat).push(c._id);
  }
  return { consult, treat };
}

/* ------------------------------------------------------------------------ *
 * Bookings
 * ------------------------------------------------------------------------ */
const BOOKING_SORTS = {
  createdAt: 'createdAt',
  date: 'eventAt', // the appointment's own instant — see Booking.eventAt
  amount: 'amount',
  status: 'status',
  name: 'fullName',
  checkIn: 'checkInTime',
};

/**
 * @returns {{ query: object, sort: object, meta: object }}
 */
async function buildBookingQuery(q) {
  const query = {};
  const and = [];

  if (q.status && q.status !== 'all') {
    const statuses = list(q.status);
    query.status = statuses.length > 1 ? { $in: statuses } : statuses[0];
  }
  if (q.branchId) query.branchId = q.branchId;
  else if (q.location && q.location !== 'all') query.preferredLocation = q.location;

  if (q.userId) query.userId = q.userId;
  if (q.specialistId) and.push(await practitionerBookingMatch(q.specialistId));
  if (q.therapistId) { const ids = list(q.therapistId); query.therapistId = ids.length > 1 ? { $in: ids } : ids[0]; }
  if (q.source) { const s = list(q.source); query.source = s.length > 1 ? { $in: s } : s[0]; }
  if (q.paymentStatus) { const s = list(q.paymentStatus); query.paymentStatus = s.length > 1 ? { $in: s } : s[0]; }
  if (q.paymentMethod) { const s = list(q.paymentMethod); query.paymentMethod = s.length > 1 ? { $in: s } : s[0]; }
  if (q.room) query.room = q.room;
  if (q.packageIncluded === 'true') query.isPackageIncluded = true;
  if (q.packageIncluded === 'false') query.isPackageIncluded = { $ne: true };
  if (q.hasRating === 'true') query.rating = { $gt: 0 };

  const amountMin = num(q.amountMin); const amountMax = num(q.amountMax);
  if (amountMin !== null || amountMax !== null) {
    query.amount = {};
    if (amountMin !== null) query.amount.$gte = amountMin;
    if (amountMax !== null) query.amount.$lte = amountMax;
  }

  // Consultation vs treatment, and the service taxonomy.
  if (q.kind === 'consultation' || q.kind === 'treatment' || q.consultationId || q.category || q.type) {
    const or = [];
    if (q.consultationId) {
      const ids = list(q.consultationId);
      or.push({ consultationId: { $in: ids } });
    } else {
      const svcQuery = {};
      if (q.category) svcQuery.category = { $in: list(q.category) };
      if (q.type) svcQuery.type = { $in: list(q.type) };
      if (q.kind === 'consultation' || q.kind === 'treatment') {
        const { consult, treat } = await consultationIdsByKind();
        svcQuery._id = { $in: q.kind === 'consultation' ? consult : treat };
      }
      const ids = (await Consultation.find(svcQuery).select('_id').lean()).map((c) => c._id);
      or.push({ consultationId: { $in: ids } });
      // Zenoti-mirrored visits carry the service name only.
      if (q.kind === 'consultation') or.push({ consultationId: null, externalServiceName: CONSULT_RX });
      if (q.kind === 'treatment') or.push({ consultationId: null, externalServiceName: { $not: CONSULT_RX, $exists: true } });
      if (q.category) or.push({ consultationId: null, externalServiceCategory: { $in: list(q.category) } });
    }
    and.push({ $or: or });
  }

  // Guest attributes (membership) → pre-query users.
  if (q.memberType) {
    const ids = (await User.find({ memberType: q.memberType }).select('_id').lean()).map((u) => u._id);
    and.push({ userId: { $in: ids } });
  }

  // Dates: a rescheduled booking lives on its confirmed date, not the one first asked for.
  const slotRange = (from, to) => {
    const range = {};
    if (from) range.$gte = from;
    if (to) range.$lte = to;
    return {
      $or: [
        { confirmedDate: range },
        { confirmedDate: { $in: [null, undefined] }, preferredDate: range },
      ],
    };
  };
  if (q.date) {
    and.push(slotRange(dayStart(q.date), dayEnd(q.date)));
  } else if (q.startDate || q.endDate) {
    and.push(slotRange(dayStart(q.startDate), dayEnd(q.endDate)));
  }
  if (q.createdFrom || q.createdTo) {
    query.createdAt = {};
    if (dayStart(q.createdFrom)) query.createdAt.$gte = dayStart(q.createdFrom);
    if (dayEnd(q.createdTo)) query.createdAt.$lte = dayEnd(q.createdTo);
  }
  if (q.checkedInFrom || q.checkedInTo) {
    query.checkInTime = {};
    if (dayStart(q.checkedInFrom)) query.checkInTime.$gte = dayStart(q.checkedInFrom);
    if (dayEnd(q.checkedInTo)) query.checkInTime.$lte = dayEnd(q.checkedInTo);
  }

  if (q.search) {
    const rx = { $regex: escapeRx(q.search), $options: 'i' };
    and.push({ $or: [{ fullName: rx }, { email: rx }, { mobileNumber: rx }, { referenceNumber: rx }, { externalServiceName: rx }] });
  }
  if (and.length) query.$and = and;

  /*
   * Sort — newest first, on ONE field.
   *
   * This used to be `{ confirmedDate: dir, preferredDate: dir, slotTime: dir }`.
   * Mongo compares those keys in order, and a booking mirrored from Zenoti has
   * no confirmedDate at all, so every mirrored visit sorted as null and sank
   * below every app booking whatever its date — producing the "this month,
   * then four years ago, then another date" ordering. `eventAt` collapses the
   * two dates plus the time of day into a single instant (see Booking.eventAt),
   * so one key gives a true chronological order for both kinds of row.
   *
   * `_id` breaks ties so pagination can't repeat or drop a row.
   */
  const dir = q.sortOrder === 'asc' ? 1 : -1;
  let sort = { eventAt: -1, _id: -1 };
  if (BOOKING_SORTS[q.sortBy]) sort = { [BOOKING_SORTS[q.sortBy]]: dir, _id: dir };

  return { query, sort };
}

/* ------------------------------------------------------------------------ *
 * Patients
 * ------------------------------------------------------------------------ */
const USER_SORTS = {
  createdAt: 'createdAt',
  name: 'fullName',
  visits: 'totalVisits',
  spend: 'totalSpent',
  lastLogin: 'lastLogin',
  dob: 'dateOfBirth',
  zenExpiry: 'zenMembershipExpiryDate',
};

/**
 * @returns {{ filter: object, sort: object }}
 */
async function buildUserFilter(q) {
  const filter = {};
  const and = [];

  if (q.memberType && q.memberType !== 'All Members') filter.memberType = q.memberType;
  if (q.location && q.location !== 'All Locations') { const l = list(q.location); filter.location = l.length > 1 ? { $in: l } : l[0]; }
  if (q.source === 'app' || q.source === 'zenoti' || q.source === 'reception') filter.source = q.source;
  if (q.gender) { const g = list(q.gender); filter.gender = g.length > 1 ? { $in: g } : g[0]; }
  if (q.isActive === 'true') filter.isActive = { $ne: false };
  if (q.isActive === 'false') filter.isActive = false;
  if (q.verified === 'true') filter.isVerified = true;
  if (q.verified === 'false') filter.isVerified = { $ne: true };

  // Age — dateOfBirth is stored as an ISO-like string, so compare lexically.
  const ageMin = num(q.ageMin); const ageMax = num(q.ageMax);
  if (ageMin !== null || ageMax !== null) {
    const today = new Date();
    const dob = {};
    if (ageMin !== null) { const d = new Date(today); d.setFullYear(d.getFullYear() - ageMin); dob.$lte = `${isoDate(d)}T23:59:59`; }
    if (ageMax !== null) { const d = new Date(today); d.setFullYear(d.getFullYear() - ageMax - 1); d.setDate(d.getDate() + 1); dob.$gte = isoDate(d); }
    filter.dateOfBirth = dob;
  }

  const range = (field, from, to) => {
    if (!from && !to) return;
    filter[field] = {};
    if (from) filter[field].$gte = from;
    if (to) filter[field].$lte = to;
  };
  range('createdAt', dayStart(q.joinedFrom), dayEnd(q.joinedTo));
  range('lastLogin', dayStart(q.lastLoginFrom), dayEnd(q.lastLoginTo));
  range('totalVisits', num(q.visitsMin), num(q.visitsMax));
  range('totalSpent', num(q.spendMin), num(q.spendMax));

  // Zen membership state.
  const now = new Date();
  if (q.zen === 'active') and.push({ memberType: 'Zen Member', $or: [{ zenMembershipExpiryDate: null }, { zenMembershipExpiryDate: { $gte: now } }] });
  if (q.zen === 'expiring') { const soon = new Date(now); soon.setDate(soon.getDate() + (num(q.zenDays) ?? 30)); and.push({ memberType: 'Zen Member', zenMembershipExpiryDate: { $gte: now, $lte: soon } }); }
  if (q.zen === 'expired') and.push({ zenMembershipExpiryDate: { $lt: now } });
  if (q.zen === 'none') and.push({ memberType: { $ne: 'Zen Member' } });

  // Flags.
  const flags = list(q.flags);
  if (q.hasFlags === 'true' || flags.length) {
    const or = [];
    if (!flags.length || flags.includes('allergies')) { or.push({ hasDrugAllergy: true }); or.push({ drugAllergies: { $regex: /\S/ } }); }
    if (!flags.length || flags.includes('medical')) or.push({ medicalHistory: { $regex: /\S/ } });
    if (!flags.length || flags.includes('inactive')) or.push({ isActive: false });
    if (flags.includes('smoking')) or.push({ smoking: { $in: ['Yes', 'yes', true, 'Occasionally', 'Regularly'] } });
    if (flags.includes('drinking')) or.push({ drinking: { $in: ['Yes', 'yes', true, 'Occasionally', 'Regularly'] } });
    and.push({ $or: or });
  }
  if (q.hasFlags === 'false') and.push({ $nor: [{ hasDrugAllergy: true }, { drugAllergies: { $regex: /\S/ } }, { medicalHistory: { $regex: /\S/ } }, { isActive: false }] });

  // Visit history — derived from bookings (the app has no lastVisit field).
  const bookingMatch = {};
  if (q.consultationId) bookingMatch.consultationId = { $in: list(q.consultationId) };
  if (q.category) bookingMatch.$or = [{ externalServiceCategory: { $in: list(q.category) } }];
  if (q.specialistId) bookingMatch.$and = [...(bookingMatch.$and || []), await practitionerBookingMatch(q.specialistId)];
  if (q.bookingStatus) bookingMatch.status = { $in: list(q.bookingStatus) };
  if (q.kind === 'consultation' || q.kind === 'treatment') {
    const { consult, treat } = await consultationIdsByKind();
    const byId = { consultationId: { $in: q.kind === 'consultation' ? consult : treat } };
    const byName = q.kind === 'consultation'
      ? { consultationId: null, externalServiceName: CONSULT_RX }
      : { consultationId: null, externalServiceName: { $exists: true, $not: CONSULT_RX } };
    bookingMatch.$and = [...(bookingMatch.$and || []), { $or: [byId, byName] }];
  }
  if (q.category && !q.consultationId) {
    const ids = (await Consultation.find({ category: { $in: list(q.category) } }).select('_id').lean()).map((c) => c._id);
    bookingMatch.$or.push({ consultationId: { $in: ids } });
  }
  if (q.lastVisitFrom || q.lastVisitTo) {
    const r = {};
    if (dayStart(q.lastVisitFrom)) r.$gte = dayStart(q.lastVisitFrom);
    if (dayEnd(q.lastVisitTo)) r.$lte = dayEnd(q.lastVisitTo);
    bookingMatch.$and = [...(bookingMatch.$and || []), { status: 'Completed' }, { $or: [{ checkOutTime: r }, { checkOutTime: null, confirmedDate: r }, { checkOutTime: null, confirmedDate: null, preferredDate: r }] }];
  }
  if (q.noVisitSince) {
    // Lapsed guests: last completed visit before this date (or never).
    const cutoff = dayStart(q.noVisitSince);
    const recent = await Booking.distinct('userId', { status: { $in: ['Completed', 'In Progress', 'Confirmed'] }, $or: [{ checkOutTime: { $gte: cutoff } }, { confirmedDate: { $gte: cutoff } }, { preferredDate: { $gte: cutoff } }] });
    and.push({ _id: { $nin: recent } });
  }
  if (Object.keys(bookingMatch).length) {
    const ids = await Booking.distinct('userId', bookingMatch);
    and.push({ _id: { $in: ids } });
  }

  if (q.search) {
    const rx = { $regex: escapeRx(q.search), $options: 'i' };
    and.push({ $or: [{ fullName: rx }, { email: rx }, { phone: rx }, { patientId: rx }] });
  }
  if (and.length) filter.$and = and;

  const dir = q.sortOrder === 'asc' ? 1 : -1;
  const field = USER_SORTS[q.sortBy] || (q.sortBy && /^[a-zA-Z.]+$/.test(q.sortBy) ? q.sortBy : 'createdAt');
  const sort = { [field]: dir, _id: dir };
  return { filter, sort };
}

module.exports = { buildBookingQuery, buildUserFilter, consultationIdsByKind, practitionerBookingMatch, list };
