const mongoose = require('mongoose');
const Booking = require('../models/Booking');
const ProductOrder = require('../models/ProductOrder');
const PackageAssignment = require('../models/PackageAssignment');
const Consultation = require('../models/Consultation');
const Branch = require('../models/Branch');
const User = require('../models/User');
const Inventory = require('../models/Inventory');
// Registered here so populate('packageId') works even when this controller is
// the first thing to touch packages in a process (scripts, tests).
require('../models/Package');
const {
  CLINIC_TIME_ZONE, addClinicDays, clinicDateKey, clinicDayEnd, clinicDayStart, formatClinicDate, parseClockMinutes,
} = require('../utils/bookingTime');
const { COUNTABLE: BOOKING_COUNTABLE, ATTENDED: BOOKING_PRESENT_OR_DONE } = require('../utils/bookingStatuses');
const { guestCodeOf } = require('../utils/guestCode');

// Get Financial Dashboard Analytics

/** Booking filter fragment for a branch (by id) — empty when not scoped. */
const branchScope = (req) => {
  const b = req.query.branchId;
  if (!b || b === 'all') return {};
  return mongoose.Types.ObjectId.isValid(b) ? { branchId: new mongoose.Types.ObjectId(b) } : { preferredLocation: b };
};
/** Optional date window from startDate/endDate query params. */
const dateScope = (req, field = 'createdAt') => {
  const { startDate, endDate } = req.query;
  if (!startDate && !endDate) return {};
  const r = {};
  if (startDate) r.$gte = clinicDayStart(startDate);
  if (endDate) r.$lte = clinicDayEnd(endDate);
  return { [field]: r };
};

/*
 * The panel sends "All time" as an endDate with no startDate — or, to the
 * endpoints that used to fall back to their own last-30-days, a start of
 * 2015-01-01 (lib/ranges.ts ALL_TIME_FLOOR). Either means "no lower bound".
 */
const ALL_TIME_FLOOR_KEY = '2015-01-01';

/**
 * ONE reading of the report window for every analytics handler.
 *
 * Before this each handler read the range its own way — `startDate`/`endDate`
 * here, `days` there, `from`/`to` for staff sales, and four endpoints took no
 * range at all — so flipping "This month" to "Last 90 days" moved some tiles
 * and not others, and the totals stopped agreeing with each other.
 *
 * Inputs, in order of precedence: `startDate`/`endDate` (clinic day keys, or
 * ISO instants converted to their clinic day), then `from`/`to` (the staff
 * sales report's older names), then `days` (the guests endpoint's older form:
 * that many clinic days ending today). With nothing given, the last
 * `defaultDays` clinic days ending today; pass `defaultDays: null` for
 * "everything" (the dashboard's default).
 *
 * A missing start is OPEN — no lower bound — whenever an end was given, and a
 * start at or before the 2015 floor is open too. Open means `start` is null,
 * `startKey` is null and `days` is null; callers that need a concrete day (a
 * daily series, an average per day) pick the oldest record themselves.
 *
 * Returns `{ start: Date|null, end: Date, startKey, endKey, days, openStart }`;
 * `end` is the inclusive end-of-day instant, ready for `$lte`.
 */
function reportWindow(req, { defaultDays = 30 } = {}) {
  const q = (req && req.query) || {};
  const keyOf = (v) => {
    if (v === undefined || v === null || v === '') return null;
    const d = clinicDayStart(v);
    return d ? clinicDateKey(d) : null;
  };
  const today = clinicDateKey(new Date());
  const endGiven = keyOf(q.endDate) || keyOf(q.to);
  const endKey = endGiven || today;
  let startKey = keyOf(q.startDate) || keyOf(q.from);
  let openStart = false;
  if (startKey) {
    if (startKey <= ALL_TIME_FLOOR_KEY) { openStart = true; startKey = null; }
  } else if (endGiven) {
    openStart = true;
  } else {
    const n = q.days !== undefined && q.days !== '' ? Math.floor(Number(q.days)) : null;
    const span = n && n > 0 ? n : defaultDays;
    if (span === null || span === undefined) openStart = true;
    else startKey = addClinicDays(endKey, -(Math.max(1, span) - 1));
  }
  const end = clinicDayEnd(endKey);
  const start = openStart ? null : clinicDayStart(startKey);
  const days = openStart ? null : Math.max(1, Math.round((end - start + 1) / 86400000));
  return { start, end, startKey, endKey, days, openStart };
}
exports.reportWindow = reportWindow;

/** `{ field: { $gte?, $lte } }` for a window — no `$gte` when the start is open. */
const within = (w, field) => ({ [field]: { ...(w.start ? { $gte: w.start } : {}), $lte: w.end } });
/** Money is recognised when paid; legacy paid rows without `paidAt` fall back to `createdAt`. */
const paidWithin = (w) => ({ paymentStatus: 'paid', $or: [within(w, 'paidAt'), { paidAt: null, ...within(w, 'createdAt') }] });
/** Package money by its received date, else the assignment's creation. */
const receivedWithin = (w) => ({ 'payment.isReceived': true, $or: [within(w, 'payment.receivedDate'), { 'payment.receivedDate': null, ...within(w, 'createdAt') }] });
/** Bookings "happen" on their slot day: the confirmed date, else the preferred one. */
const slotWithin = (w) => ({ $or: [within(w, 'confirmedDate'), { confirmedDate: null, ...within(w, 'preferredDate') }] });
/** The response's account of the window, so a tile can say what it covers. */
const windowOut = (w) => (w.openStart ? 'all-time' : { startKey: w.startKey, endKey: w.endKey });

/*
 * Time-series buckets. A window of two months or less is read day by day (the
 * "This month" chart); anything longer, month by month. Keys are clinic days
 * and clinic months — `$dateToString` with the clinic zone in the database,
 * `clinicDateKey` in JavaScript — so both sides agree on where a day ends.
 */
const DAY_SERIES_MAX_DAYS = 62;
const seriesGranularity = (w) => (!w.openStart && w.days <= DAY_SERIES_MAX_DAYS ? 'day' : 'month');
const bucketFormat = (granularity) => (granularity === 'day' ? '%Y-%m-%d' : '%Y-%m');
const monthKeyOf = (dayKey) => dayKey.slice(0, 7);
/** YYYY-MM plus whole months, without touching the server's local calendar. */
const addMonths = (monthKey, n) => {
  const [y, m] = monthKey.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const monthLabel = (monthKey) => formatClinicDate(clinicDayStart(`${monthKey}-01`), { month: 'short', year: 'numeric' });
const dayLabel = (dayKey) => formatClinicDate(clinicDayStart(dayKey), { month: 'short', day: 'numeric', year: 'numeric' });
/** Every bucket key from `fromKey` to `toKey` (clinic days), even the empty ones — a chart needs its zeros. */
function bucketKeys(granularity, fromKey, toKey) {
  const keys = [];
  if (!fromKey || !toKey || fromKey > toKey) return keys;
  if (granularity === 'day') {
    for (let k = fromKey; k <= toKey; k = addClinicDays(k, 1)) keys.push(k);
    return keys;
  }
  const last = monthKeyOf(toKey);
  for (let k = monthKeyOf(fromKey); k <= last; k = addMonths(k, 1)) keys.push(k);
  return keys;
}
/** `$group` a stream into `{ _id: bucketKey, value }` — the sum done in the database, not here. */
const bucketStage = (granularity, dateExpr, amountExpr) => ({
  $group: {
    _id: { $dateToString: { format: bucketFormat(granularity), date: dateExpr, timezone: CLINIC_TIME_ZONE } },
    value: { $sum: amountExpr },
  },
});
/** Numbers as the database sees them: a string amount or a null counts as 0, like `Number(x) || 0`. */
const num = (expr) => ({ $convert: { input: expr, to: 'double', onError: 0, onNull: 0 } });
/** The centre name behind a `branchId` query value — the branch-name filters need it. */
async function branchNameOf(scope) {
  if (scope.preferredLocation) return scope.preferredLocation;
  if (scope.branchId) return (await Branch.findById(scope.branchId).select('name').lean())?.name || null;
  return null;
}

exports.getFinancialAnalytics = async (req, res) => {
  try {
    const { branchId } = req.query;
    // Clinic-day window; an open start (All time) drops the lower bound.
    const win = reportWindow(req, { defaultDays: 30 });
    const { start, end } = win;

    // Build query filters
    const bookingFilter = {
      ...within(win, 'createdAt'),
      status: { $in: BOOKING_COUNTABLE }
    };

    const orderFilter = {
      ...within(win, 'createdAt'),
      orderStatus: { $nin: ['Cancelled', 'Returned'] }
    };

    const packageFilter = {
      ...within(win, 'createdAt'),
      status: { $in: ['Active', 'Completed'] }
    };

    if (branchId) {
      bookingFilter.branchId = branchId;
    }

    // The three main sets feed several breakdowns (centre, category, tender,
    // the daily series), so they are still shaped here — but only the fields
    // those breakdowns read, as plain objects. The whole history used to come
    // in as full hydrated documents for "All time".
    const [bookings, productOrders, packageAssignments] = await Promise.all([
      Booking.find(bookingFilter)
        .select('consultationId branchId preferredLocation createdAt')
        .populate('consultationId', 'name price category')
        .populate('branchId', 'name location')
        .lean(),
      ProductOrder.find(orderFilter).select('pricing paymentMethod createdAt').lean(),
      PackageAssignment.find(packageFilter).select('pricing payment createdAt').lean(),
    ]);
    
    // Calculate consultation revenue
    const consultationRevenue = bookings.reduce((total, booking) => {
      return total + (booking.consultationId?.price || 0);
    }, 0);
    
    // Calculate product revenue
    const productRevenue = productOrders.reduce((total, order) => {
      return total + (order.pricing?.total || 0);
    }, 0);
    
    // Calculate package revenue
    const packageRevenue = packageAssignments.reduce((total, assignment) => {
      return total + (assignment.pricing?.finalAmount || 0);
    }, 0);
    
    // Total revenue
    const totalRevenue = consultationRevenue + productRevenue + packageRevenue;
    
    // Outstanding (pending orders, unpaid packages) and lost (cancelled orders,
    // cancelled visits at catalogue price) are plain sums — the database adds
    // them up instead of shipping every row here to be added up.
    const total = (Model, match, amountExpr) => Model.aggregate([
      { $match: match }, { $group: { _id: null, value: { $sum: amountExpr } } },
    ]).then((r) => (r[0] && r[0].value) || 0);
    const [pendingOrderTotal, unpaidPackageTotal, cancelledOrderTotal, cancelledBookingTotal] = await Promise.all([
      total(ProductOrder, { ...within(win, 'createdAt'), paymentStatus: 'Pending', orderStatus: { $nin: ['Cancelled'] } }, num('$pricing.total')),
      total(PackageAssignment, { ...within(win, 'createdAt'), 'payment.isReceived': false, status: { $ne: 'Cancelled' } }, num('$pricing.finalAmount')),
      total(ProductOrder, { ...within(win, 'createdAt'), orderStatus: { $in: ['Cancelled', 'Returned'] } }, num('$pricing.total')),
      Booking.aggregate([
        { $match: { ...within(win, 'createdAt'), status: 'Cancelled' } },
        { $lookup: { from: 'consultations', localField: 'consultationId', foreignField: '_id', as: 'svc' } },
        { $group: { _id: null, value: { $sum: num({ $arrayElemAt: ['$svc.price', 0] }) } } },
      ]).then((r) => (r[0] && r[0].value) || 0),
    ]);

    const outstandingPayments = pendingOrderTotal + unpaidPackageTotal;
    const refundsLost = cancelledOrderTotal + cancelledBookingTotal;
    
    // Payment method distribution
    const paymentMethodDistribution = {
      Cash: 0,
      Card: 0,
      UPI: 0,
      'Bank Transfer': 0,
      COD: 0,
      Other: 0
    };
    
    productOrders.forEach(order => {
      if (paymentMethodDistribution.hasOwnProperty(order.paymentMethod)) {
        paymentMethodDistribution[order.paymentMethod] += order.pricing.total;
      }
    });
    
    packageAssignments.forEach(assignment => {
      if (assignment.payment.isReceived && assignment.payment.paymentMethod) {
        const method = assignment.payment.paymentMethod;
        if (paymentMethodDistribution.hasOwnProperty(method)) {
          paymentMethodDistribution[method] += assignment.pricing.finalAmount;
        }
      }
    });
    
    // Average transaction value
    const totalTransactions = bookings.length + productOrders.length + packageAssignments.length;
    const averageTransactionValue = totalTransactions > 0 ? totalRevenue / totalTransactions : 0;
    
    // Revenue by location/branch
    const revenueByLocation = {};
    bookings.forEach(booking => {
      const location = booking.branchId?.name || booking.preferredLocation || 'Unknown';
      if (!revenueByLocation[location]) {
        revenueByLocation[location] = 0;
      }
      revenueByLocation[location] += booking.consultationId?.price || 0;
    });
    
    // Revenue by service category
    const revenueByCategory = {};
    bookings.forEach(booking => {
      const category = booking.consultationId?.category || 'Uncategorized';
      if (!revenueByCategory[category]) {
        revenueByCategory[category] = 0;
      }
      revenueByCategory[category] += booking.consultationId?.price || 0;
    });
    
    // Daily revenue trend (last 30 days)
    const dailyRevenue = [];
    // Buckets are CLINIC days. setHours() uses the server's timezone, so on a
    // UTC host every bucket ran 00:00-24:00 UTC and a 9pm IST booking landed in
    // the next day's column — the same off-by-one the panels showed.
    const todayKey = clinicDateKey(new Date());
    for (let i = 29; i >= 0; i--) {
      const dayKey = addClinicDays(todayKey, -i);
      const date = clinicDayStart(dayKey);
      const nextDate = new Date(clinicDayEnd(dayKey).getTime() + 1);
      
      const dayBookings = bookings.filter(b => {
        const bookingDate = new Date(b.createdAt);
        return bookingDate >= date && bookingDate < nextDate;
      });
      
      const dayOrders = productOrders.filter(o => {
        const orderDate = new Date(o.createdAt);
        return orderDate >= date && orderDate < nextDate;
      });
      
      const dayPackages = packageAssignments.filter(p => {
        const packageDate = new Date(p.createdAt);
        return packageDate >= date && packageDate < nextDate;
      });
      
      const dayRevenue = 
        dayBookings.reduce((sum, b) => sum + (b.consultationId?.price || 0), 0) +
        dayOrders.reduce((sum, o) => sum + o.pricing.total, 0) +
        dayPackages.reduce((sum, p) => sum + p.pricing.finalAmount, 0);
      
      dailyRevenue.push({
        date: dayKey,
        revenue: dayRevenue,
        consultations: dayBookings.length,
        orders: dayOrders.length,
        packages: dayPackages.length
      });
    }
    
    // Week-over-week growth
    const lastWeekStart = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const previousWeekStart = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    
    const lastWeekRevenue = dailyRevenue
      .filter(day => new Date(day.date) >= lastWeekStart)
      .reduce((sum, day) => sum + day.revenue, 0);
    
    const previousWeekRevenue = dailyRevenue
      .filter(day => {
        const date = new Date(day.date);
        return date >= previousWeekStart && date < lastWeekStart;
      })
      .reduce((sum, day) => sum + day.revenue, 0);
    
    const weekOverWeekGrowth = previousWeekRevenue > 0
      ? ((lastWeekRevenue - previousWeekRevenue) / previousWeekRevenue) * 100
      : 0;
    
    res.status(200).json({
      success: true,
      data: {
        overview: {
          totalRevenue,
          consultationRevenue,
          productRevenue,
          packageRevenue,
          outstandingPayments,
          refundsLost,
          averageTransactionValue,
          totalTransactions,
          weekOverWeekGrowth
        },
        paymentMethodDistribution,
        revenueByLocation,
        revenueByCategory,
        dailyRevenue,
        period: {
          // `startDate` is null when the start is open (All time).
          startDate: start,
          endDate: end,
          startKey: win.startKey,
          endKey: win.endKey,
          openStart: win.openStart,
          window: windowOut(win),
        }
      }
    });
  } catch (error) {
    console.error('Error fetching financial analytics:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch financial analytics',
      error: error.message
    });
  }
};

/**
 * Monthly revenue with the SAME definition as the dashboard: money actually
 * charged (Booking.amount when paid, order and package totals, membership
 * payments, and the clinic's own Zenoti package and retail sales by sale
 * date). The old version priced visits from the catalogue — which every
 * mirrored clinic visit lacks — bucketed by server-local month, and double
 * counted the mirrored clinic sales, so it never matched the tiles.
 *
 * Two shapes, chosen by whether a range was sent:
 *   - no range (older callers): the last 12 clinic months, as before —
 *     `data: [{ month, monthKey, consultationRevenue, productRevenue,
 *     packageRevenue, membershipRevenue, totalRevenue }]`
 *   - startDate/endDate (the panel's range picker): the window bucketed by
 *     day when it spans 62 days or fewer, else by month —
 *     `data: { granularity: 'day'|'month', points: [{ key, label, value,
 *     ...the same four streams }], window }`
 * The sums are done by the database, per bucket; nothing is loaded here.
 */
const rangeGiven = (req) => ['startDate', 'endDate', 'from', 'to', 'days'].some((k) => req.query[k] !== undefined && req.query[k] !== '');

async function revenueBuckets(win, scope, granularity) {
  const ZenotiGuestData = require('../models/ZenotiGuestData');
  const Payment = require('../models/Payment');
  const branchName = await branchNameOf(scope);
  const bookingBranch = scope.branchId ? { $or: [{ branchId: scope.branchId }, { branchId: null, preferredLocation: branchName }] } : scope;
  const appOnly = { source: { $ne: 'zenoti' } };
  const clinic = (field, dateField) => ZenotiGuestData.aggregate([
    { $match: branchName ? { branchName } : {} }, { $unwind: `$${field}` },
    { $addFields: { d: { $convert: { input: `$${field}.${dateField}`, to: 'date', onError: null, onNull: null } } } },
    { $match: within(win, 'd') },
    bucketStage(granularity, '$d', { $ifNull: [`$${field}.price`, 0] }),
  ]);

  const [bookings, orders, packages, memberships, zOrders, zPackages] = await Promise.all([
    Booking.aggregate([
      { $match: { $and: [bookingBranch, paidWithin(win)] } },
      bucketStage(granularity, { $ifNull: ['$paidAt', '$createdAt'] }, num('$amount')),
    ]),
    ProductOrder.aggregate([
      { $match: { ...appOnly, paymentStatus: 'Paid', orderStatus: { $nin: ['Cancelled', 'Returned'] }, ...within(win, 'createdAt') } },
      bucketStage(granularity, '$createdAt', num('$pricing.total')),
    ]),
    PackageAssignment.aggregate([
      { $match: { ...appOnly, ...(branchName ? { preferredLocation: branchName } : {}), ...receivedWithin(win) } },
      bucketStage(granularity, { $ifNull: ['$payment.receivedDate', '$createdAt'] }, num('$pricing.finalAmount')),
    ]),
    Payment.aggregate([
      { $match: { orderType: 'ZenMembership', status: 'captured', ...within(win, 'createdAt') } },
      bucketStage(granularity, '$createdAt', num('$amount')),
    ]),
    clinic('orders', 'saleDate'),
    clinic('packages', 'purchaseDate'),
  ]);

  const streams = [
    ['consultationRevenue', bookings], ['productRevenue', orders], ['packageRevenue', packages],
    ['membershipRevenue', memberships], ['productRevenue', zOrders], ['packageRevenue', zPackages],
  ];
  // With an open start the series begins at the oldest bucket that has money in it.
  const seen = streams.flatMap(([, rows]) => rows.map((r) => r._id)).filter(Boolean).sort();
  const fromKey = win.openStart ? (seen[0] ? (granularity === 'day' ? seen[0] : `${seen[0]}-01`) : null) : win.startKey;
  const buckets = new Map(bucketKeys(granularity, fromKey, win.endKey).map((key) => [key, {
    key, label: granularity === 'day' ? dayLabel(key) : monthLabel(key),
    consultationRevenue: 0, productRevenue: 0, packageRevenue: 0, membershipRevenue: 0, totalRevenue: 0,
  }]));
  for (const [field, rows] of streams) {
    for (const r of rows) {
      const b = buckets.get(r._id);
      if (!b) continue;
      const n = Number(r.value) || 0;
      b[field] += n; b.totalRevenue += n;
    }
  }
  return [...buckets.values()].map((b) => ({ ...b, totalRevenue: Math.round(b.totalRevenue) }));
}

exports.getMonthlyRevenueTrend = async (req, res) => {
  try {
    const scope = branchScope(req);
    if (rangeGiven(req)) {
      const win = reportWindow(req, { defaultDays: null });
      const granularity = seriesGranularity(win);
      const rows = await revenueBuckets(win, scope, granularity);
      return res.status(200).json({
        success: true,
        data: {
          granularity,
          points: rows.map((b) => ({ ...b, value: b.totalRevenue })),
          window: windowOut(win),
        },
      });
    }

    // Older callers: the last 12 clinic months, oldest first.
    const todayKey = clinicDateKey(new Date());
    const firstKey = `${addMonths(monthKeyOf(todayKey), -11)}-01`;
    const win = { start: clinicDayStart(firstKey), end: clinicDayEnd(todayKey), startKey: firstKey, endKey: todayKey, days: null, openStart: false };
    const rows = await revenueBuckets(win, scope, 'month');
    return res.status(200).json({
      success: true,
      data: rows.map(({ key, label, ...b }) => ({ month: label, monthKey: key, ...b })),
    });
  } catch (error) {
    console.error('Error fetching monthly revenue trend:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch monthly revenue trend',
      error: error.message
    });
  }
};

// Get Daily Collection Target Progress
exports.getDailyTargetProgress = async (req, res) => {
  try {
    // "Today" is the clinic's day, not the server's.
    const todayKey = clinicDateKey(new Date());
    const today = clinicDayStart(todayKey);
    const tomorrow = new Date(clinicDayEnd(todayKey).getTime() + 1);
    
    const bookings = await Booking.find({
      createdAt: { $gte: today, $lt: tomorrow },
      status: { $in: BOOKING_COUNTABLE }
    }).populate('consultationId', 'price');
    
    const orders = await ProductOrder.find({
      createdAt: { $gte: today, $lt: tomorrow },
      orderStatus: { $nin: ['Cancelled', 'Returned'] }
    });
    
    const packages = await PackageAssignment.find({
      createdAt: { $gte: today, $lt: tomorrow },
      status: { $in: ['Active', 'Completed'] },
      'payment.isReceived': true
    });
    
    const todayCollection = 
      bookings.reduce((sum, b) => sum + (b.consultationId?.price || 0), 0) +
      orders.reduce((sum, o) => sum + o.pricing.total, 0) +
      packages.reduce((sum, p) => sum + p.pricing.finalAmount, 0);
    
    // Set daily target (can be configured)
    const dailyTarget = 50000; // ₹50,000 default target
    const progressPercentage = (todayCollection / dailyTarget) * 100;
    
    res.status(200).json({
      success: true,
      data: {
        todayCollection,
        dailyTarget,
        progressPercentage: Math.min(progressPercentage, 100),
        difference: todayCollection - dailyTarget,
        achieved: todayCollection >= dailyTarget
      }
    });
  } catch (error) {
    console.error('Error fetching daily target progress:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch daily target progress',
      error: error.message
    });
  }
};

// Get Patient Analytics Overview
exports.getPatientAnalytics = async (req, res) => {
  try {
    // startDate/endDate from the panel's range picker; `days` is the older
    // form this endpoint always took (that many clinic days ending today).
    const win = reportWindow(req, { defaultDays: 30 });
    const endDate = win.end;

    // Total guests, and the ones who joined inside the window — a count over
    // the `createdAt` index. This used to load every user's createdAt (7,000+
    // rows) into memory on every call and count them in JavaScript.
    const [totalPatients, newPatients] = await Promise.all([
      User.countDocuments(),
      User.countDocuments(within(win, 'createdAt')),
    ]);

    // Get returning patients (patients with more than 1 booking)
    const returningPatients = await Booking.aggregate([
      {
        $match: {
          ...within(win, 'createdAt'),
          status: { $in: BOOKING_COUNTABLE },
          ...branchScope(req)
        }
      },
      {
        $group: {
          _id: '$userId',
          bookingCount: { $sum: 1 }
        }
      },
      {
        $match: { bookingCount: { $gt: 1 } }
      },
      {
        $count: 'total'
      }
    ]);
    
    const returningCount = returningPatients[0]?.total || 0;
    
    // Calculate ratios
    const totalInPeriod = newPatients + returningCount;
    const newPatientRatio = totalInPeriod > 0 ? (newPatients / totalInPeriod) * 100 : 0;
    const returningPatientRatio = totalInPeriod > 0 ? (returningCount / totalInPeriod) * 100 : 0;
    
    // Calculate retention rate (patients who returned in last 3 months)
    const threeMonthsAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const retentionData = await Booking.aggregate([
      {
        $match: {
          createdAt: { $gte: threeMonthsAgo, $lte: endDate },
          status: { $in: BOOKING_COUNTABLE }
        }
      },
      {
        $group: {
          _id: '$userId',
          bookingCount: { $sum: 1 }
        }
      },
      {
        $match: { bookingCount: { $gte: 2 } }
      },
      {
        $count: 'total'
      }
    ]);
    
    const retainedPatients = retentionData[0]?.total || 0;
    const retentionRate = totalPatients > 0 ? (retainedPatients / totalPatients) * 100 : 0;
    
    // Get birthdays today
    const today = new Date();
    const todayMonth = today.getMonth() + 1; // getMonth() returns 0-11, we need 1-12
    const todayDay = today.getDate();
    
    console.log(`🎂 Checking birthdays for: Month ${todayMonth}, Day ${todayDay}`);
    
    const birthdaysToday = await User.find({
      dateOfBirth: { $exists: true, $ne: null }
    }).select('fullName email phone dateOfBirth').lean();
    
    console.log(`📊 Found ${birthdaysToday.length} users with dateOfBirth`);
    
    // Filter birthdays for today (check only month and day, ignore year)
    const todayBirthdays = birthdaysToday.filter(user => {
      if (!user.dateOfBirth) return false;
      
      try {
        let month, day;
        
        // Handle different date formats
        if (typeof user.dateOfBirth === 'string') {
          // Format: "1990-10-20" or "1990-10-20T00:00:00.000Z" or "20/10/1990"
          const dateStr = user.dateOfBirth.split('T')[0]; // Remove time part if exists
          
          if (dateStr.includes('-')) {
            // ISO format: "1990-10-20"
            const parts = dateStr.split('-');
            month = parseInt(parts[1]);
            day = parseInt(parts[2]);
          } else if (dateStr.includes('/')) {
            // Format: "20/10/1990" (DD/MM/YYYY)
            const parts = dateStr.split('/');
            day = parseInt(parts[0]);
            month = parseInt(parts[1]);
          }
        } else if (user.dateOfBirth instanceof Date) {
          // If stored as Date object
          month = user.dateOfBirth.getMonth() + 1;
          day = user.dateOfBirth.getDate();
        }
        
        const isMatch = month === todayMonth && day === todayDay;
        
        if (isMatch) {
          console.log(`🎉 Birthday match found: ${user.fullName} - ${user.dateOfBirth}`);
        }
        
        return isMatch;
      } catch (error) {
        console.error(`❌ Error parsing date for user ${user.fullName}:`, error.message);
        return false;
      }
    }).slice(0, 10).map(user => ({
      _id: user._id,
      name: user.fullName,
      email: user.email,
      phone: user.phone,
      dateOfBirth: user.dateOfBirth
    }));
    
    console.log(`✅ Total birthdays today: ${todayBirthdays.length}`);
    
    // Inactive guests (no booking in 3+ months) = everyone minus the guests
    // with a booking made since the threshold. Same set as the old per-user
    // `$lookup` of every booking — "latest booking on or before the threshold,
    // or none at all" — without joining 7,000 users to the bookings collection
    // on every load. The `$in` against users drops bookings whose guest record
    // no longer exists, which the lookup never counted either.
    const recentlyBookedIds = await Booking.distinct('userId', { createdAt: { $gt: threeMonthsAgo } });
    const recentlyActive = recentlyBookedIds.length
      ? await User.countDocuments({ _id: { $in: recentlyBookedIds } })
      : 0;
    const inactiveCount = Math.max(0, totalPatients - recentlyActive);

    // Get membership status
    const now = new Date();
    const [activeMemberships, expiredMemberships, pendingMemberships] = await Promise.all([
      User.countDocuments({ membershipStatus: 'Active' }).catch(() => 0),
      // Expired: an expiry date that has passed. Pending: a member with no expiry recorded.
      User.countDocuments({ memberType: 'Zen Member', zenMembershipExpiryDate: { $lt: now } }),
      User.countDocuments({ memberType: 'Zen Member', zenMembershipExpiryDate: null }),
    ]);
    
    res.status(200).json({
      success: true,
      data: {
        overview: {
          totalPatients,
          newPatients,
          returningPatients: returningCount,
          newPatientRatio,
          returningPatientRatio,
          retentionRate
        },
        birthdaysToday: todayBirthdays,
        inactivePatients: {
          count: inactiveCount,
          threshold: '3+ months'
        },
        membershipStatus: {
          active: activeMemberships,
          expired: expiredMemberships,
          pending: pendingMemberships
        },
        window: windowOut(win),
      }
    });
  } catch (error) {
    console.error('Error fetching patient analytics:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch patient analytics',
      error: error.message
    });
  }
};

/**
 * Guests joined, over time.
 *
 * Two shapes, chosen by whether a range was sent (like the revenue trend):
 *   - no range (older callers): the last 12 clinic months — `data: [{ month, count }]`
 *   - startDate/endDate: the window, by day when it spans 62 days or fewer,
 *     else by month — `data: { granularity, points: [{ key, label, value }], window }`
 * Counted by the database per bucket, in the clinic's calendar. This used to
 * load every user's createdAt and count them in JavaScript, in the SERVER's
 * calendar — a guest who joined at 2am IST on the 1st sat in the previous
 * month's column on a UTC host.
 */
exports.getPatientAcquisitionTrend = async (req, res) => {
  try {
    const branchName = await branchNameOf(branchScope(req));
    const userBranch = branchName ? { location: branchName } : {};
    const ranged = rangeGiven(req);
    const todayKey = clinicDateKey(new Date());
    const win = ranged
      ? reportWindow(req, { defaultDays: null })
      : (() => { const firstKey = `${addMonths(monthKeyOf(todayKey), -11)}-01`; return { start: clinicDayStart(firstKey), end: clinicDayEnd(todayKey), startKey: firstKey, endKey: todayKey, days: null, openStart: false }; })();
    const granularity = ranged ? seriesGranularity(win) : 'month';

    const rows = await User.aggregate([
      { $match: { ...userBranch, ...within(win, 'createdAt') } },
      bucketStage(granularity, '$createdAt', 1),
    ]);
    const seen = rows.map((r) => r._id).filter(Boolean).sort();
    const fromKey = win.openStart ? (seen[0] ? (granularity === 'day' ? seen[0] : `${seen[0]}-01`) : null) : win.startKey;
    const counts = new Map(rows.map((r) => [r._id, Number(r.value) || 0]));
    const points = bucketKeys(granularity, fromKey, win.endKey).map((key) => ({
      key, label: granularity === 'day' ? dayLabel(key) : monthLabel(key), value: counts.get(key) || 0,
    }));

    res.status(200).json({
      success: true,
      data: ranged
        ? { granularity, points, window: windowOut(win) }
        : points.map((p) => ({ month: p.label, count: p.value })),
    });
  } catch (error) {
    console.error('Error fetching patient acquisition trend:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch patient acquisition trend',
      error: error.message
    });
  }
};

// Get Top Valuable Patients
exports.getTopPatients = async (req, res) => {
  try {
    // Spend is what the guest actually paid — visits (Booking.amount when
    // paid), app packages and orders, and the clinic's own Zenoti package and
    // retail sales — inside the requested window and centre. The old version
    // summed CATALOGUE prices and dropped every visit without a catalogue link,
    // which is most clinic history.
    const limit = Math.min(50, parseInt(req.query.limit, 10) || 5);
    const ZenotiGuestData = require('../models/ZenotiGuestData');
    const { publicEmail } = require('../config/zenoti');
    const scope = branchScope(req);
    const branchName = await branchNameOf(scope);
    // No range at all means everything; an open start keeps only the end bound.
    const ranged = rangeGiven(req);
    const win = reportWindow(req, { defaultDays: null });
    const start = ranged ? win.start : null;
    const end = ranged ? win.end : null;
    const inWindow = (d) => Boolean(d) && (!start || d >= start) && (!end || d <= end);
    const windowOn = (field) => (start || end ? { [field]: { ...(start ? { $gte: start } : {}), ...(end ? { $lte: end } : {}) } } : {});

    const spend = new Map();
    const visits = new Map();
    const bump = (uid, amt, visit) => {
      if (!uid) return;
      const k = String(uid);
      spend.set(k, (spend.get(k) || 0) + (Number(amt) || 0));
      if (visit) visits.set(k, (visits.get(k) || 0) + 1);
    };

    const bookingBranch = scope.branchId ? { $or: [{ branchId: scope.branchId }, { branchId: null, preferredLocation: branchName }] } : scope;
    const appOnly = { source: { $ne: 'zenoti' } };
    const clinic = (field, dateField) => ZenotiGuestData.aggregate([
      { $match: branchName ? { branchName } : {} }, { $unwind: `$${field}` },
      { $addFields: { d: { $convert: { input: `$${field}.${dateField}`, to: 'date', onError: null, onNull: null } } } },
      ...(start || end ? [{ $match: windowOn('d') }] : [{ $match: { d: { $ne: null } } }]),
      { $group: { _id: '$userId', revenue: { $sum: { $ifNull: [`$${field}.price`, 0] } } } },
    ]);
    const [bookings, packages, orders, zPackages, zOrders] = await Promise.all([
      Booking.find({ $and: [bookingBranch, { paymentStatus: 'paid' }, ...(start || end ? [{ $or: [windowOn('paidAt'), { paidAt: null, ...windowOn('createdAt') }] }] : [])] }).select('userId amount paidAt createdAt').lean(),
      PackageAssignment.find({ ...appOnly, 'payment.isReceived': true, ...(branchName ? { preferredLocation: branchName } : {}) }).select('userId pricing payment createdAt').lean(),
      ProductOrder.find({ ...appOnly, paymentStatus: 'Paid', orderStatus: { $nin: ['Cancelled', 'Returned'] }, ...windowOn('createdAt') }).select('userId pricing createdAt').lean(),
      clinic('packages', 'purchaseDate'),
      clinic('orders', 'saleDate'),
    ]);
    bookings.forEach((b) => bump(b.userId, b.amount, true));
    packages.forEach((p) => { if (!start && !end || inWindow((p.payment && p.payment.receivedDate) || p.createdAt)) bump(p.userId, p.pricing && p.pricing.finalAmount, false); });
    orders.forEach((o) => bump(o.userId, o.pricing && o.pricing.total, false));
    zPackages.forEach((r) => bump(r._id, r.revenue, false));
    zOrders.forEach((r) => bump(r._id, r.revenue, false));

    const top = [...spend.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, limit);
    const users = await User.find({ _id: { $in: top.map(([id]) => id) } }).select('fullName email phone').lean();
    const byId = new Map(users.map((u) => [String(u._id), u]));
    res.status(200).json({
      success: true,
      window: ranged ? windowOut(win) : 'all-time',
      data: top.map(([id, totalSpent]) => {
        const u = byId.get(id) || {};
        const visitCount = visits.get(id) || 0;
        return { _id: id, name: u.fullName, fullName: u.fullName, email: publicEmail(u.email), phone: u.phone, totalSpent: Math.round(totalSpent), visitCount, visits: visitCount };
      }),
    });
  } catch (error) {
    console.error('Error fetching top patients:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch top patients',
      error: error.message
    });
  }
};

/**
 * Age and gender of the guest population — of guests who joined inside the
 * window when one is given, of everyone otherwise. The response says which
 * (`window: 'all-time' | { startKey, endKey }`) so the tile can be labelled.
 * Age stays in JavaScript: dateOfBirth is stored as a Date OR as a string in
 * two written formats, which no aggregation expression parses cleanly.
 */
exports.getPatientDemographics = async (req, res) => {
  try {
    const win = reportWindow(req, { defaultDays: null });
    const branchName = await branchNameOf(branchScope(req));
    const population = {
      ...(branchName ? { location: branchName } : {}),
      ...(win.openStart ? {} : within(win, 'createdAt')),
    };

    // Age distribution
    const patients = await User.find({ ...population, dateOfBirth: { $exists: true, $ne: null } }).select('dateOfBirth').lean();
    
    const ageGroups = {
      '0-18': 0,
      '19-30': 0,
      '31-45': 0,
      '46-60': 0,
      '61+': 0
    };
    
    const today = new Date();
    patients.forEach(patient => {
      try {
        // Handle both string and Date types
        const dob = typeof patient.dateOfBirth === 'string' ? new Date(patient.dateOfBirth) : patient.dateOfBirth;
        if (!isNaN(dob.getTime())) {
          const age = today.getFullYear() - dob.getFullYear();
          if (age <= 18) ageGroups['0-18']++;
          else if (age <= 30) ageGroups['19-30']++;
          else if (age <= 45) ageGroups['31-45']++;
          else if (age <= 60) ageGroups['46-60']++;
          else ageGroups['61+']++;
        }
      } catch (err) {
        // Skip invalid dates
        console.log('Invalid date for patient:', patient._id);
      }
    });
    
    const total = patients.length;
    const ageGroupsArray = Object.entries(ageGroups).map(([range, count]) => ({
      range,
      count,
      percentage: total > 0 ? (count / total) * 100 : 0
    }));
    
    // Gender distribution — one pass; anything that is not Male/Female
    // (including no gender at all) is "other", as the three counts were.
    const genderRows = await User.aggregate([{ $match: population }, { $group: { _id: '$gender', count: { $sum: 1 } } }]);
    let male = 0; let female = 0; let other = 0;
    for (const g of genderRows) {
      if (g._id === 'Male') male += g.count;
      else if (g._id === 'Female') female += g.count;
      else other += g.count;
    }
    const totalGender = male + female + other;
    
    res.status(200).json({
      success: true,
      data: {
        ageGroups: ageGroupsArray,
        gender: {
          male,
          female,
          other,
          total: totalGender
        },
        window: windowOut(win),
      }
    });
  } catch (error) {
    console.error('Error fetching patient demographics:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch patient demographics',
      error: error.message
    });
  }
};

// Get Patient Sources
exports.getPatientSources = async (req, res) => {
  try {
    // Guests who joined inside the window when one is given, everyone otherwise;
    // the response's `window` says which.
    const win = reportWindow(req, { defaultDays: null });
    const branchName = await branchNameOf(branchScope(req));
    const population = {
      ...(branchName ? { location: branchName } : {}),
      ...(win.openStart ? {} : within(win, 'createdAt')),
    };
    // Since referralSource field doesn't exist in User model, 
    // we'll use location as a proxy for now or return default data
    const sources = await User.aggregate([
      { $match: population },
      {
        $group: {
          _id: '$location',
          count: { $sum: 1 }
        }
      },
      {
        $sort: { count: -1 }
      }
    ]);
    
    const total = sources.reduce((sum, source) => sum + source.count, 0);
    
    // Map location to source channels (can be updated later)
    const sourcesWithPercentage = sources.map(source => ({
      source: source._id || 'Direct',
      count: source.count,
      percentage: total > 0 ? (source.count / total) * 100 : 0
    }));
    
    // Add default sources if no data
    if (sourcesWithPercentage.length === 0) {
      sourcesWithPercentage.push(
        { source: 'Instagram', count: 0, percentage: 0 },
        { source: 'Google', count: 0, percentage: 0 },
        { source: 'Direct', count: 0, percentage: 0 },
        { source: 'Referral', count: 0, percentage: 0 }
      );
    }
    
    res.status(200).json({
      success: true,
      window: windowOut(win),
      data: sourcesWithPercentage
    });
  } catch (error) {
    console.error('Error fetching patient sources:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch patient sources',
      error: error.message
    });
  }
};

// Send Birthday Wish Email
exports.sendBirthdayWish = async (req, res) => {
  try {
    const { userId } = req.params;
    
    if (!userId) {
      return res.status(400).json({
        success: false,
        message: 'User ID is required'
      });
    }

    // Get user details
    const user = await User.findById(userId).select('fullName email');
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (!user.email) {
      return res.status(400).json({
        success: false,
        message: 'User email not found'
      });
    }

    // Import email service
    const { sendBirthdayWish } = require('../utils/emailService');
    
    // Send birthday wish email
    await sendBirthdayWish(user.email, user.fullName);

    res.status(200).json({
      success: true,
      message: `Birthday wish sent successfully to ${user.fullName}!`
    });
  } catch (error) {
    console.error('Error sending birthday wish:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send birthday wish email',
      error: error.message
    });
  }
};

// ========================================
// APPOINTMENT & BOOKING ANALYTICS
// ========================================

// Get Comprehensive Appointment Analytics
exports.getAppointmentAnalytics = async (req, res) => {
  try {
    // Default to last 30 clinic days; an open start (All time) has no lower bound.
    const win = reportWindow(req, { defaultDays: 30 });
    const today = clinicDateKey(new Date());
    const { end } = win;
    const slotRange = (from, to) => ({
      $or: [
        { confirmedDate: { $gte: from, $lte: to } },
        { confirmedDate: null, preferredDate: { $gte: from, $lte: to } },
      ],
    });
    
    // Get all bookings in date range. Peak hours, weekday spread, the per-guest
    // gap and the no-show split each read a different field of every row, so
    // the rows are still shaped here — but only those fields, as plain objects.
    const bookings = await Booking.find({
      ...slotWithin(win),
      ...branchScope(req)
    }).select('status confirmedTime slotTime preferredTimeSlots confirmedDate preferredDate consultationId externalServiceCategory userId')
      .populate('consultationId', 'name category').lean();

    // With an open start the averages run from the oldest visit on record.
    const start = win.start || bookings.reduce((m, b) => { const d = new Date(b.confirmedDate || b.preferredDate); return !Number.isNaN(d.getTime()) && (!m || d < m) ? d : m; }, null) || clinicDayStart(today);

    const totalBookings = bookings.length;
    const completedBookings = bookings.filter(b => b.status === 'Completed').length;
    const cancelledBookings = bookings.filter(b => b.status === 'Cancelled').length;
    const noShowBookings = bookings.filter(b => b.status === 'No Show').length;
    const pendingBookings = bookings.filter(b => b.status === 'Awaiting Confirmation').length;

    // 1. Appointment Conversion Rate
    const conversionRate = totalBookings > 0 ? (completedBookings / totalBookings) * 100 : 0;

    // 2. Average Appointments per Day/Week/Month
    const daysDiff = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) || 1;
    const avgPerDay = totalBookings / daysDiff;
    const avgPerWeek = avgPerDay * 7;
    const avgPerMonth = avgPerDay * 30;

    // 3. Peak Booking Hours (0-23)
    const hourlyBookings = Array(24).fill(0);
    bookings.forEach(booking => {
      const time = booking.confirmedTime || booking.slotTime || booking.preferredTimeSlots?.[0];
      if (time) {
        const minutes = parseClockMinutes(time);
        const hour = minutes === null ? NaN : Math.floor(minutes / 60);
        if (!isNaN(hour) && hour >= 0 && hour < 24) {
          hourlyBookings[hour]++;
        }
      }
    });

    // 4. Peak Booking Days (0=Sunday, 6=Saturday)
    const dayOfWeekBookings = Array(7).fill(0);
    bookings.forEach(booking => {
      const key = clinicDateKey(booking.confirmedDate || booking.preferredDate);
      if (!key) return;
      const [y, m, d] = key.split('-').map(Number);
      const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
      dayOfWeekBookings[day]++;
    });

    // 5. Cancellation Rate Trend (last 7 days)
    const cancellationTrend = [];
    for (let i = 6; i >= 0; i--) {
      const key = addClinicDays(today, -i);

      const dayBookings = bookings.filter(b => {
        return clinicDateKey(b.confirmedDate || b.preferredDate) === key;
      });

      const dayCancellations = dayBookings.filter(b => b.status === 'Cancelled').length;
      const cancellationRate = dayBookings.length > 0 ? (dayCancellations / dayBookings.length) * 100 : 0;

      cancellationTrend.push({
        date: formatClinicDate(clinicDayStart(key), { month: 'short', day: 'numeric' }),
        rate: parseFloat(cancellationRate.toFixed(1)),
        cancelled: dayCancellations,
        total: dayBookings.length
      });
    }

    // 6. No-Show Rate by Service Type (clinic visits carry their Zenoti category)
    const serviceTypeStats = {};
    bookings.forEach(booking => {
      const serviceType = booking.consultationId?.category || booking.externalServiceCategory || 'Other';
      if (!serviceTypeStats[serviceType]) {
        serviceTypeStats[serviceType] = { total: 0, noShow: 0 };
      }
      serviceTypeStats[serviceType].total++;
      if (booking.status === 'No Show') {
        serviceTypeStats[serviceType].noShow++;
      }
    });

    const noShowByService = Object.keys(serviceTypeStats).map(service => ({
      service,
      noShowRate: serviceTypeStats[service].total > 0
        ? ((serviceTypeStats[service].noShow / serviceTypeStats[service].total) * 100).toFixed(1)
        : 0,
      // `count` is what the panel chart reads; the older name stays for callers.
      count: serviceTypeStats[service].noShow,
      noShowCount: serviceTypeStats[service].noShow,
      totalBookings: serviceTypeStats[service].total
    })).filter((row) => row.count > 0).sort((a, b) => b.count - a.count);

    // 7. Average Time Between Bookings (per patient)
    const patientBookings = {};
    bookings.forEach(booking => {
      const userId = booking.userId?.toString();
      if (userId) {
        if (!patientBookings[userId]) {
          patientBookings[userId] = [];
        }
        patientBookings[userId].push(new Date(booking.confirmedDate || booking.preferredDate));
      }
    });

    let totalTimeDiffs = [];
    Object.values(patientBookings).forEach(dates => {
      if (dates.length > 1) {
        dates.sort((a, b) => a - b);
        for (let i = 1; i < dates.length; i++) {
          const diffDays = (dates[i] - dates[i - 1]) / (1000 * 60 * 60 * 24);
          totalTimeDiffs.push(diffDays);
        }
      }
    });

    const avgTimeBetweenBookings = totalTimeDiffs.length > 0
      ? totalTimeDiffs.reduce((a, b) => a + b, 0) / totalTimeDiffs.length
      : 0;

    // 8. Upcoming Appointments This Week
    const startOfWeek = clinicDayStart(today);
    const endOfWeek = clinicDayEnd(addClinicDays(today, 7));

    const upcomingThisWeek = await Booking.countDocuments({
      ...slotRange(startOfWeek, endOfWeek),
      ...branchScope(req),
      status: { $in: ['Awaiting Confirmation', 'Confirmed', 'Rescheduled'] }
    });

    // 9. Pending Confirmations Count
    const pendingConfirmations = await Booking.countDocuments({
      status: 'Awaiting Confirmation',
      ...branchScope(req),
      ...slotRange(clinicDayStart(today), clinicDayEnd(addClinicDays(today, 365)))
    });

    // Response
    res.status(200).json({
      success: true,
      data: {
        overview: {
          totalBookings,
          completedBookings,
          cancelledBookings,
          noShowBookings,
          pendingBookings,
          conversionRate: parseFloat(conversionRate.toFixed(1)),
          cancellationRate: totalBookings > 0 ? parseFloat(((cancelledBookings / totalBookings) * 100).toFixed(1)) : 0,
          noShowRate: totalBookings > 0 ? parseFloat(((noShowBookings / totalBookings) * 100).toFixed(1)) : 0
        },
        averages: {
          perDay: parseFloat(avgPerDay.toFixed(1)),
          perWeek: parseFloat(avgPerWeek.toFixed(1)),
          perMonth: parseFloat(avgPerMonth.toFixed(1))
        },
        peakHours: hourlyBookings.map((count, hour) => ({
          hour: `${hour.toString().padStart(2, '0')}:00`,
          count
        })),
        peakDays: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day, index) => ({
          day,
          count: dayOfWeekBookings[index]
        })),
        cancellationTrend,
        noShowByService,
        avgTimeBetweenBookings: parseFloat(avgTimeBetweenBookings.toFixed(1)),
        upcomingThisWeek,
        pendingConfirmations,
        window: windowOut(win),
      }
    });
  } catch (error) {
    console.error('Error fetching appointment analytics:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch appointment analytics',
      error: error.message
    });
  }
};

// ========================================
// SERVICE & TREATMENT PERFORMANCE ANALYTICS
// ========================================

// Get Comprehensive Service Analytics
exports.getServiceAnalytics = async (req, res) => {
  try {
    // Default to last 30 clinic days; an open start (All time) has no lower bound.
    const win = reportWindow(req, { defaultDays: 30 });
    
    // Visits by their slot day (like the dashboard), revenue = what was charged
    // when paid. Clinic visits without a catalogue link keep their Zenoti
    // service name and category instead of vanishing from every chart.
    // Per-service and per-category rows need the catalogue name and category
    // of each visit, so the rows are shaped here — only the fields read, lean.
    const bookings = await Booking.find({
      ...slotWithin(win),
      status: { $in: BOOKING_COUNTABLE },
      ...branchScope(req)
    }).select('consultationId externalServiceName externalServiceCategory paymentStatus amount')
      .populate('consultationId', 'name category price duration_minutes').lean();

    // The live catalogue only — hidden Zenoti shells would otherwise fill the
    // "needs attention" list with services nobody can book.
    const allServices = await Consultation.find({ isActive: { $ne: false } });

    // 1. Top 10 Services by Revenue
    const serviceRevenue = {};
    bookings.forEach(booking => {
      const serviceId = booking.consultationId?._id?.toString() || (booking.externalServiceName ? `external:${booking.externalServiceName}` : null);
      const serviceName = booking.consultationId?.name || booking.externalServiceName;
      const revenue = booking.paymentStatus === 'paid' ? Number(booking.amount) || 0 : 0;

      if (serviceId && serviceName) {
        if (!serviceRevenue[serviceId]) {
          serviceRevenue[serviceId] = {
            id: serviceId,
            name: serviceName,
            category: booking.consultationId?.category || booking.externalServiceCategory || 'Other',
            revenue: 0,
            bookings: 0
          };
        }
        serviceRevenue[serviceId].revenue += revenue;
        serviceRevenue[serviceId].bookings += 1;
      }
    });

    const topServicesByRevenue = Object.values(serviceRevenue)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    // 2. Top 10 Services by Volume
    const topServicesByVolume = Object.values(serviceRevenue)
      .sort((a, b) => b.bookings - a.bookings)
      .slice(0, 10);

    // 3. Service-wise Profit Margin (assuming 60% margin for simplicity)
    const serviceProfitMargin = topServicesByRevenue.map(service => ({
      ...service,
      cost: service.revenue * 0.4, // 40% cost
      profit: service.revenue * 0.6, // 60% profit
      margin: 60
    }));

    // 4. Least Performing Services (Underutilized)
    const allServiceIds = allServices.map(s => s._id.toString());
    const bookedServiceIds = Object.keys(serviceRevenue);
    const unbookedServices = allServiceIds.filter(id => !bookedServiceIds.includes(id));
    
    const leastPerformingServices = allServices
      .filter(service => {
        const serviceId = service._id.toString();
        return serviceRevenue[serviceId]?.bookings < 5 || unbookedServices.includes(serviceId);
      })
      .map(service => ({
        id: service._id,
        name: service.name,
        category: service.category,
        price: service.price,
        bookings: serviceRevenue[service._id.toString()]?.bookings || 0,
        revenue: serviceRevenue[service._id.toString()]?.revenue || 0
      }))
      .sort((a, b) => a.bookings - b.bookings)
      .slice(0, 10);

    // 5. Duration comparison: nothing records the actual chair time yet, so
    // this stays empty rather than the simulated numbers it used to invent.
    const durationComparison = [];

    // 6. Service Category Performance (charged amounts, clinic categories too)
    const categoryPerformance = {};
    bookings.forEach(booking => {
      const category = booking.consultationId?.category || booking.externalServiceCategory || 'Other';
      const price = booking.paymentStatus === 'paid' ? Number(booking.amount) || 0 : 0;
      
      if (!categoryPerformance[category]) {
        categoryPerformance[category] = {
          category,
          revenue: 0,
          bookings: 0,
          avgPrice: 0
        };
      }
      categoryPerformance[category].revenue += price;
      categoryPerformance[category].bookings += 1;
    });

    Object.values(categoryPerformance).forEach(cat => {
      cat.avgPrice = cat.bookings > 0 ? cat.revenue / cat.bookings : 0;
    });

    const categoryPerformanceArray = Object.values(categoryPerformance)
      .sort((a, b) => b.revenue - a.revenue);

    // 7. New Services Added This Month — the clinic's month, not the server's.
    const startOfMonth = clinicDayStart(`${clinicDateKey(new Date()).slice(0, 8)}01`);

    const newServicesThisMonth = await Consultation.find({
      createdAt: { $gte: startOfMonth }
    }).select('name category price createdAt');

    // 8. Package Utilization Rate — sessions used of sessions sold, summed per
    // package across every assignment made in the window. Assignments hold a
    // `sessions[]` list (Scheduled/Booked/Completed/Cancelled); the old code
    // read a `services` field that does not exist, so this was always empty.
    const packageAssignments = await PackageAssignment.find({
      ...within(win, 'createdAt'),
      status: { $ne: 'Cancelled' },
      ...(branchScope(req).preferredLocation ? { preferredLocation: branchScope(req).preferredLocation } : {}),
    }).select('packageId packageDetails sessions').populate('packageId', 'name').lean();

    const utilByPackage = new Map();
    for (const assignment of packageAssignments) {
      const name = assignment.packageId?.name || assignment.packageDetails?.name;
      if (!name) continue;
      const sessions = (assignment.sessions || []).filter((s) => s.status !== 'Cancelled');
      const row = utilByPackage.get(name) || { name, packageName: name, total: 0, used: 0, assignments: 0 };
      row.total += sessions.length;
      row.used += sessions.filter((s) => s.status === 'Completed').length;
      row.assignments += 1;
      utilByPackage.set(name, row);
    }
    const packageUtilization = [...utilByPackage.values()]
      .filter((r) => r.total > 0)
      .map((r) => ({
        ...r, totalSessions: r.total, usedSessions: r.used, remainingSessions: r.total - r.used,
        utilizationRate: parseFloat(((r.used / r.total) * 100).toFixed(1)),
      }))
      .sort((a, b) => b.used - a.used);

    // Response
    res.status(200).json({
      success: true,
      data: {
        topServicesByRevenue,
        topServicesByVolume,
        serviceProfitMargin: serviceProfitMargin.slice(0, 10),
        leastPerformingServices,
        durationComparison: durationComparison.slice(0, 10),
        categoryPerformance: categoryPerformanceArray,
        newServicesThisMonth: {
          count: newServicesThisMonth.length,
          services: newServicesThisMonth
        },
        packageUtilization: packageUtilization.slice(0, 10),
        summary: {
          totalRevenue: Object.values(serviceRevenue).reduce((sum, s) => sum + s.revenue, 0),
          totalBookings: bookings.length,
          totalServices: allServices.length,
          activeServices: Object.keys(serviceRevenue).length,
          avgRevenuePerService: Object.keys(serviceRevenue).length > 0 
            ? Object.values(serviceRevenue).reduce((sum, s) => sum + s.revenue, 0) / Object.keys(serviceRevenue).length
            : 0
        },
        window: windowOut(win),
      }
    });
  } catch (error) {
    console.error('Error fetching service analytics:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch service analytics',
      error: error.message
    });
  }
};

// ========================================
// INVENTORY & PRODUCT INSIGHTS
// ========================================

// Import inventory analytics from separate module
const { getInventoryAnalytics } = require('./inventoryAnalyticsController');
exports.getInventoryAnalytics = getInventoryAnalytics;

// OLD VERSION - REPLACED WITH NEW ONE
exports.getInventoryAnalyticsOld = async (req, res) => {
  try {
    // Get all inventory items
    const inventoryItems = await Inventory.find().populate('productId', 'name brand formulation price');

    // 1. Low Stock Alerts (Critical items) - Less than 20% of reorder level
    const lowStockItems = inventoryItems.filter(item => {
      const reorderLevel = item.reorderLevel || 50;
      return item.quantity <= reorderLevel * 0.2 && item.quantity > 0;
    }).map(item => ({
      id: item._id,
      productName: item.productId?.name || item.productName,
      quantity: item.quantity,
      reorderLevel: item.reorderLevel || 50,
      location: item.location,
      critical: true
    })).slice(0, 10);

    // 2. Out of Stock Items Count
    const outOfStockItems = inventoryItems.filter(item => item.quantity === 0);
    const outOfStockCount = outOfStockItems.length;

    // 3. Fast-Moving Products (Top sellers) - Based on quantity changes
    const fastMovingProducts = inventoryItems
      .filter(item => item.quantity > 0)
      .map(item => ({
        id: item._id,
        productName: item.productId?.name || item.productName,
        brand: item.productId?.brand,
        quantity: item.quantity,
        soldUnits: Math.floor(Math.random() * 100) + 50, // Simulated sales data
        turnoverRate: (Math.random() * 5 + 3).toFixed(1)
      }))
      .sort((a, b) => b.soldUnits - a.soldUnits)
      .slice(0, 10);

    // 4. Slow-Moving Inventory (Dead stock) - Low turnover
    const slowMovingInventory = inventoryItems
      .filter(item => item.quantity > 0)
      .map(item => ({
        id: item._id,
        productName: item.productId?.name || item.productName,
        quantity: item.quantity,
        daysInStock: Math.floor(Math.random() * 180) + 90, // Simulated days
        turnoverRate: (Math.random() * 0.5).toFixed(2),
        value: item.quantity * (item.productId?.price || 0)
      }))
      .sort((a, b) => parseFloat(a.turnoverRate) - parseFloat(b.turnoverRate))
      .slice(0, 10);

    // 5. Inventory Value (Total stock worth)
    const totalInventoryValue = inventoryItems.reduce((sum, item) => {
      const price = item.productId?.price || 0;
      return sum + (item.quantity * price);
    }, 0);

    const inventoryValueByCategory = {};
    inventoryItems.forEach(item => {
      const formulation = item.productId?.formulation || 'Other';
      const value = item.quantity * (item.productId?.price || 0);
      
      if (!inventoryValueByCategory[formulation]) {
        inventoryValueByCategory[formulation] = 0;
      }
      inventoryValueByCategory[formulation] += value;
    });

    // 6. Product Expiry Alerts
    const now = new Date();
    const thirtyDays = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const sixtyDays = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);
    const ninetyDays = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

    const expiringItems = inventoryItems.filter(item => item.expiryDate);
    
    const expiryAlerts = {
      expiring30Days: expiringItems.filter(item => {
        const expiryDate = new Date(item.expiryDate);
        return expiryDate >= now && expiryDate <= thirtyDays;
      }).map(item => ({
        id: item._id,
        productName: item.productId?.name || item.productName,
        quantity: item.quantity,
        expiryDate: item.expiryDate,
        daysUntilExpiry: Math.ceil((new Date(item.expiryDate) - now) / (1000 * 60 * 60 * 24))
      })),
      expiring60Days: expiringItems.filter(item => {
        const expiryDate = new Date(item.expiryDate);
        return expiryDate > thirtyDays && expiryDate <= sixtyDays;
      }).length,
      expiring90Days: expiringItems.filter(item => {
        const expiryDate = new Date(item.expiryDate);
        return expiryDate > sixtyDays && expiryDate <= ninetyDays;
      }).length
    };

    // 7. Reorder Point Status
    const itemsNeedingReorder = inventoryItems.filter(item => {
      const reorderLevel = item.reorderLevel || 50;
      return item.quantity <= reorderLevel && item.quantity > 0;
    }).map(item => ({
      id: item._id,
      productName: item.productId?.name || item.productName,
      currentQuantity: item.quantity,
      reorderLevel: item.reorderLevel || 50,
      deficit: (item.reorderLevel || 50) - item.quantity
    }));

    // 8. Vendor Performance (Simulated data)
    const vendorPerformance = [
      { vendor: 'Vendor A', deliveryTime: 3.5, qualityRating: 4.5, onTimeDelivery: 92 },
      { vendor: 'Vendor B', deliveryTime: 2.8, qualityRating: 4.8, onTimeDelivery: 95 },
      { vendor: 'Vendor C', deliveryTime: 4.2, qualityRating: 4.2, onTimeDelivery: 88 },
      { vendor: 'Vendor D', deliveryTime: 3.1, qualityRating: 4.6, onTimeDelivery: 90 }
    ];

    // 9. Product-wise Profit Margin (Assuming 40% cost)
    const productProfitMargins = inventoryItems
      .filter(item => item.quantity > 0 && item.productId?.price)
      .map(item => ({
        productName: item.productId?.name || item.productName,
        sellingPrice: item.productId?.price || 0,
        cost: (item.productId?.price || 0) * 0.6, // 60% of price as cost
        profit: (item.productId?.price || 0) * 0.4, // 40% profit
        margin: 40,
        quantity: item.quantity
      }))
      .sort((a, b) => b.profit - a.profit)
      .slice(0, 10);

    // 10. Inventory Turnover Ratio
    const totalCost = inventoryItems.reduce((sum, item) => {
      return sum + (item.quantity * (item.productId?.price || 0) * 0.6);
    }, 0);

    const avgInventoryCost = totalCost / 2; // Simplified average
    const cogs = totalCost * 2; // Simulated COGS
    const inventoryTurnoverRatio = avgInventoryCost > 0 ? (cogs / avgInventoryCost).toFixed(2) : 0;

    // Response
    res.status(200).json({
      success: true,
      data: {
        summary: {
          totalItems: inventoryItems.length,
          totalValue: Math.round(totalInventoryValue),
          lowStockCount: lowStockItems.length,
          outOfStockCount,
          reorderNeededCount: itemsNeedingReorder.length,
          expiringIn30Days: expiryAlerts.expiring30Days.length
        },
        lowStockAlerts: lowStockItems,
        outOfStockItems: outOfStockItems.slice(0, 10).map(item => ({
          id: item._id,
          productName: item.productId?.name || item.productName,
          location: item.location,
          lastRestocked: item.lastRestocked
        })),
        fastMovingProducts,
        slowMovingInventory,
        inventoryValue: {
          total: Math.round(totalInventoryValue),
          byCategory: Object.keys(inventoryValueByCategory).map(category => ({
            category,
            value: Math.round(inventoryValueByCategory[category])
          })).sort((a, b) => b.value - a.value)
        },
        expiryAlerts,
        reorderPointStatus: itemsNeedingReorder.slice(0, 10),
        vendorPerformance,
        productProfitMargins,
        inventoryTurnoverRatio: parseFloat(inventoryTurnoverRatio)
      }
    });
  } catch (error) {
    console.error('Error fetching inventory analytics:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch inventory analytics',
      error: error.message
    });
  }
};

module.exports = exports;

/**
 * GET /api/analytics/sales/today?date=YYYY-MM-DD&branchId=
 *
 * Zenoti's "Today's Sales" register: every payment taken on a clinic day —
 * service visits paid at the desk, product orders paid, package sales
 * received — with totals by tender. Read-only; the desk opens a row from here.
 */
exports.getTodaysSales = async (req, res) => {
  try {
    const Invoice = require('../models/Invoice');
    const day = req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : null;
    const start = clinicDayStart(day || new Date());
    const end = clinicDayEnd(day || new Date());
    const scope = branchScope(req);
    const inDay = (field) => ({ [field]: { $gte: start, $lte: end } });
    const invScope = scope.branchId ? { branchId: scope.branchId } : {};

    const [invoices, visits, orders, packages] = await Promise.all([
      // Every bill raised or settled on the day, open / closed / void alike (Zenoti's register).
      Invoice.find({ ...invScope, $or: [inDay('issuedAt'), inDay('closedAt')] })
        .select('invoiceNumber receiptNumber guest userId lines totals status source payments closedAt issuedAt createdByName closedByName')
        .sort({ issuedAt: -1 }).lean(),
      // Visits paid without a bill (app / Razorpay, legacy desk "mark paid", Zenoti-mirrored).
      Booking.find({ ...scope, invoiceId: null, paymentStatus: 'paid', amount: { $gt: 0 }, $or: [inDay('paidAt'), { paidAt: null, ...inDay('checkOutTime') }] })
        .populate('consultationId', 'name').populate('userId', 'fullName phone patientId guestCode')
        .select('referenceNumber fullName mobileNumber amount paymentMethod paidAt checkOutTime status specialistName consultationId externalServiceName userId preferredLocation zenotiSource source')
        .sort({ paidAt: -1 }).lean(),
      ProductOrder.find({ ...(scope.branchId ? { branchId: scope.branchId } : {}), paymentStatus: { $in: ['paid', 'Paid', 'completed'] }, $or: [inDay('paidAt'), { paidAt: null, ...inDay('updatedAt') }] })
        .populate('userId', 'fullName phone patientId guestCode')
        .select('orderNumber userId items totalAmount finalAmount paymentMethod paymentStatus orderStatus paidAt createdAt')
        .sort({ createdAt: -1 }).lean().catch(() => []),
      PackageAssignment.find({ ...(scope.branchId ? { branchId: scope.branchId } : {}), invoiceId: null, 'payment.isReceived': true, ...inDay('payment.receivedDate') })
        .populate('userId', 'fullName phone patientId guestCode')
        .select('assignmentId packageDetails.packageName pricing.finalAmount payment userId createdAt')
        .sort({ 'payment.receivedDate': -1 }).lean(),
    ]);

    const methodsOf = (inv) => { const s = {}; for (const p of inv.payments || []) if (!p.voided) s[p.method === 'Custom' ? (p.customName || 'Custom') : p.method] = (s[p.method === 'Custom' ? (p.customName || 'Custom') : p.method] || 0) + p.amount; return s; };
    const rows = [
      ...invoices.map((i) => {
        const m = methodsOf(i);
        return {
          kind: 'invoice', id: i._id, ref: i.invoiceNumber, receipt: i.receiptNumber || null,
          customer: i.guest?.name || null, phone: i.guest?.phone || null, patientId: guestCodeOf(i.guest), guestCode: i.guest?.guestCode || null, userId: i.userId || null,
          items: (i.lines || []).map((l) => `${l.name} (${l.qty})`), amount: i.status === 'void' ? 0 : (i.totals?.total || 0), due: i.status === 'void' ? 0 : (i.totals?.due || 0),
          method: Object.keys(m).join(' + ') || null, methods: m, at: i.closedAt || i.issuedAt, status: i.status.toUpperCase(), source: i.source === 'zenoti' ? 'Zenoti' : i.source === 'app' ? 'App' : 'Desk', staff: i.closedByName || i.createdByName || null,
        };
      }),
      ...visits.map((b) => ({
        kind: 'visit', id: b._id, ref: b.referenceNumber || b.zenotiSource?.invoiceNumber || null, receipt: b.zenotiSource?.receiptNumber || null,
        customer: b.userId?.fullName || b.fullName, phone: b.userId?.phone || b.mobileNumber || null, patientId: guestCodeOf(b.userId), guestCode: b.userId?.guestCode || null, userId: b.userId?._id || null,
        items: [`${b.consultationId?.name || b.externalServiceName || 'Service'} (1)`], amount: b.amount || 0, due: 0,
        method: b.paymentMethod || 'Clinic', methods: { [b.paymentMethod || 'Clinic']: b.amount || 0 }, at: b.paidAt || b.checkOutTime || null, status: 'CLOSED', source: b.source === 'zenoti' ? 'Zenoti' : b.source === 'app' ? 'App' : 'Desk', staff: b.specialistName || null,
      })),
      ...orders.map((o) => ({
        kind: 'order', id: o._id, ref: o.orderNumber || null, receipt: null,
        customer: o.userId?.fullName || null, phone: o.userId?.phone || null, patientId: guestCodeOf(o.userId), guestCode: o.userId?.guestCode || null, userId: o.userId?._id || null,
        items: (o.items || []).map((i) => `${i.name || i.productName || 'Product'} (${i.quantity || 1})`), amount: o.finalAmount ?? o.totalAmount ?? 0, due: 0,
        method: o.paymentMethod || null, methods: { [o.paymentMethod || 'Online']: o.finalAmount ?? o.totalAmount ?? 0 }, at: o.paidAt || o.createdAt || null, status: String(o.orderStatus || '').toUpperCase() || 'PAID', source: 'App', staff: null,
      })),
      ...packages.map((p) => ({
        kind: 'package', id: p._id, ref: p.assignmentId || null, receipt: null,
        customer: p.userId?.fullName || null, phone: p.userId?.phone || null, patientId: guestCodeOf(p.userId), guestCode: p.userId?.guestCode || null, userId: p.userId?._id || null,
        items: [`${p.packageDetails?.packageName || 'Package'} (1)`], amount: p.pricing?.finalAmount || 0, due: 0,
        method: p.payment?.paymentMethod || null, methods: { [p.payment?.paymentMethod || 'Other']: p.pricing?.finalAmount || 0 }, at: p.payment?.receivedDate || p.createdAt || null, status: 'CLOSED', source: 'Desk', staff: null,
      })),
    ].sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));

    const byMethod = {};
    for (const r of rows) { if (r.status === 'VOID') continue; for (const [m, v] of Object.entries(r.methods || {})) byMethod[m] = (byMethod[m] || 0) + (v || 0); }
    const live = rows.filter((r) => r.status !== 'VOID');
    const collected = live.reduce((n, r) => n + Math.max(0, (r.amount || 0) - (r.due || 0)), 0);
    const invoiceDue = live.reduce((n, r) => n + (r.due || 0), 0);
    // Visits done or in progress today that have neither been billed nor paid.
    const dueRows = await Booking.find({ ...scope, invoiceId: null, paymentStatus: { $ne: 'paid' }, amount: { $gt: 0 }, status: { $in: BOOKING_PRESENT_OR_DONE }, $or: [inDay('checkOutTime'), inDay('checkInTime'), inDay('preferredDate')] })
      .select('amount').lean();
    const sumKind = (k) => live.filter((r) => r.kind === k).reduce((n, r) => n + (r.amount || 0), 0);
    const invoiceLines = (kind) => invoices.filter((i) => i.status !== 'void').reduce((n, i) => n + (i.lines || []).filter((l) => l.kind === kind).reduce((m, l) => m + (l.total || 0), 0), 0);

    return res.json({
      success: true,
      data: {
        date: day || clinicDateKeySafe(start),
        totals: {
          count: live.length, amount: collected,
          visits: sumKind('visit') + invoiceLines('service'), products: sumKind('order') + invoiceLines('product'), packages: sumKind('package') + invoiceLines('package'),
          due: invoiceDue + dueRows.reduce((n, b) => n + (b.amount || 0), 0), dueCount: live.filter((r) => r.due > 0).length + dueRows.length,
          open: invoices.filter((i) => i.status === 'open').length, void: invoices.filter((i) => i.status === 'void').length,
          byMethod,
        },
        rows,
      },
    });
  } catch (error) {
    console.error('Today sales error:', error);
    return res.status(500).json({ success: false, message: 'Could not load today\'s sales' });
  }
};

/**
 * GET /api/admin/analytics/sales/by-staff?from&to&branchId
 * Zenoti's "Employee sales": who sold what, from closed invoices (sale-by per
 * line), plus visits paid without a bill attributed to their dermatologist.
 */
exports.getSalesByStaff = async (req, res) => {
  try {
    const Invoice = require('../models/Invoice');
    // `from`/`to` are this report's older names; startDate/endDate work too.
    // Default: the last 30 clinic days. An open start has no lower bound.
    const win = reportWindow(req, { defaultDays: 30 });
    const { start: from, end: to } = win;
    const scope = branchScope(req);
    const invScope = scope.branchId ? { branchId: scope.branchId } : {};
    const invoices = await Invoice.find({ ...invScope, status: 'closed', ...within(win, 'closedAt') }).select('lines closedAt invoiceNumber').lean();
    const rows = new Map();
    const bump = (name, kind, amount, qty = 1) => {
      const k = name || 'Unattributed';
      const r = rows.get(k) || { staff: k, services: 0, products: 0, packages: 0, memberships: 0, other: 0, total: 0, items: 0, bills: new Set() };
      r[kind] = (r[kind] || 0) + amount; r.total += amount; r.items += qty; rows.set(k, r); return r;
    };
    for (const inv of invoices) for (const l of inv.lines || []) {
      const kind = l.kind === 'service' ? 'services' : l.kind === 'product' ? 'products' : l.kind === 'package' ? 'packages' : l.kind === 'membership' ? 'memberships' : 'other';
      const r = bump(l.soldByName, kind, Number(l.total) || 0, Number(l.qty) || 1); r.bills.add(String(inv._id));
    }
    const visits = await Booking.find({ ...scope, invoiceId: null, paymentStatus: 'paid', amount: { $gt: 0 }, ...within(win, 'paidAt') }).select('specialistName amount').lean();
    for (const b of visits) bump(b.specialistName, 'services', Number(b.amount) || 0);
    const data = [...rows.values()].map((r) => ({ ...r, bills: r.bills.size, total: Math.round(r.total * 100) / 100 })).sort((a, b) => b.total - a.total);
    // `range.from` is null when the start is open (All time).
    return res.json({ success: true, data, range: { from, to, window: windowOut(win) }, totals: { total: data.reduce((n, r) => n + r.total, 0), staff: data.length, invoices: invoices.length } });
  } catch (error) {
    console.error('sales by staff error:', error);
    return res.status(500).json({ success: false, message: 'Could not build the staff sales report' });
  }
};

function clinicDateKeySafe(d) {
  try { return require('../utils/bookingTime').clinicDateKey(d); } catch { return null; }
}
