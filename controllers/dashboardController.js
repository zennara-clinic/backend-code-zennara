/**
 * GET /api/admin/analytics/dashboard?branchId=&startDate=&endDate=
 *
 * One call that answers "what is happening in the clinic": revenue for every
 * stream (consultations, treatments, products, packages, Zen memberships —
 * app and clinic/Zenoti), counts, the dermatologist leaderboard, top services,
 * revenue per centre, payment mix and a daily series for the chart.
 *
 * Revenue uses what was actually charged (`Booking.amount`, `pricing.total`,
 * `pricing.finalAmount`, `Payment.amount`), never catalogue prices.
 */
const mongoose = require('mongoose');
const Booking = require('../models/Booking');
const ProductOrder = require('../models/ProductOrder');
const PackageAssignment = require('../models/PackageAssignment');
const Payment = require('../models/Payment');
const Consultation = require('../models/Consultation');
const Doctor = require('../models/Doctor');
const ZenotiPractitioner = require('../models/ZenotiPractitioner');
const User = require('../models/User');
const Branch = require('../models/Branch');
const ZenotiGuestData = require('../models/ZenotiGuestData');
const { consultationIdsByKind } = require('../utils/listFilters');
const { canonicalName } = require('../utils/dermatologistMatch');

const CONSULT_RX = /consult|counsel/i;
const dayKey = (d) => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 10); };
const sum = (arr, f) => arr.reduce((n, x) => n + (Number(f(x)) || 0), 0);
const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

exports.getDashboard = async (req, res) => {
  try {
    // ---- window + scope ---------------------------------------------------
    const end = req.query.endDate ? new Date(req.query.endDate) : new Date();
    end.setHours(23, 59, 59, 999);
    const start = req.query.startDate ? new Date(req.query.startDate) : new Date(end.getTime() - 29 * 86400000);
    start.setHours(0, 0, 0, 0);
    const days = Math.max(1, Math.round((end - start) / 86400000));
    const prevStart = new Date(start.getTime() - days * 86400000);
    const prevEnd = new Date(start.getTime() - 1);

    const b = req.query.branchId;
    let branchName = null;
    let branchId = null;
    if (b && b !== 'all') {
      if (mongoose.Types.ObjectId.isValid(b)) { branchId = new mongoose.Types.ObjectId(b); branchName = (await Branch.findById(branchId).select('name').lean())?.name || null; }
      else branchName = b;
    }
    const bookingBranch = branchId ? { $or: [{ branchId }, { branchId: null, preferredLocation: branchName }] } : branchName ? { preferredLocation: branchName } : {};
    const userBranch = branchName ? { location: branchName } : {};
    const pkgBranch = branchId ? { $or: [{ branchId }, { branchId: null, preferredLocation: branchName }] } : branchName ? { preferredLocation: branchName } : {};

    // Bookings "happen" on their slot date; money is recognised when paid.
    const slotIn = (s, e) => ({ $or: [{ confirmedDate: { $gte: s, $lte: e } }, { confirmedDate: null, preferredDate: { $gte: s, $lte: e } }] });
    const paidIn = (s, e) => ({ paymentStatus: 'paid', $or: [{ paidAt: { $gte: s, $lte: e } }, { paidAt: null, createdAt: { $gte: s, $lte: e } }] });

    const { consult } = await consultationIdsByKind();
    const consultSet = new Set(consult.map(String));
    const isConsult = (bk) => (bk.consultationId ? consultSet.has(String(bk.consultationId)) : CONSULT_RX.test(bk.externalServiceName || ''));

    // ---- pull the window's rows (small enough to shape in memory) ---------
    const bookingFields = 'consultationId externalServiceName externalServiceCategory status amount paymentStatus paymentMethod paidAt createdAt confirmedDate preferredDate specialistId specialistName specialistTier zenotiTherapistId zenotiTherapistName source preferredLocation branchId rating userId isPackageIncluded';
    const [bookings, paidBookings, prevPaidBookings, orders, prevOrders, packages, prevPackages, memberships, prevMemberships] = await Promise.all([
      Booking.find({ ...bookingBranch, ...slotIn(start, end) }).select(bookingFields).lean(),
      Booking.find({ ...bookingBranch, ...paidIn(start, end) }).select(bookingFields).lean(),
      Booking.find({ ...bookingBranch, ...paidIn(prevStart, prevEnd) }).select('amount').lean(),
      ProductOrder.find({ createdAt: { $gte: start, $lte: end }, ...(branchName ? {} : {}) }).select('pricing paymentStatus paymentMethod orderStatus createdAt userId items').lean(),
      ProductOrder.find({ createdAt: { $gte: prevStart, $lte: prevEnd }, paymentStatus: 'Paid' }).select('pricing').lean(),
      PackageAssignment.find({ ...pkgBranch, createdAt: { $gte: start, $lte: end } }).select('pricing payment status createdAt packageDetails packageId userId').lean(),
      PackageAssignment.find({ ...pkgBranch, createdAt: { $gte: prevStart, $lte: prevEnd }, 'payment.isReceived': true }).select('pricing').lean(),
      Payment.find({ orderType: 'ZenMembership', status: 'captured', createdAt: { $gte: start, $lte: end } }).select('amount method createdAt userId').lean(),
      Payment.find({ orderType: 'ZenMembership', status: 'captured', createdAt: { $gte: prevStart, $lte: prevEnd } }).select('amount userId').lean(),
    ]);

    // Product orders have no branch; when scoped, attribute by the guest's home centre.
    let ordersScoped = orders;
    let membershipsScoped = memberships;
    if (branchName) {
      const ids = [...new Set([...orders, ...memberships].map((o) => String(o.userId)).filter(Boolean))];
      const local = new Set((await User.find({ _id: { $in: ids }, location: branchName }).select('_id').lean()).map((u) => String(u._id)));
      ordersScoped = orders.filter((o) => local.has(String(o.userId)));
      membershipsScoped = memberships.filter((m) => local.has(String(m.userId)));
    }
    const paidOrders = ordersScoped.filter((o) => o.paymentStatus === 'Paid' && o.orderStatus !== 'Cancelled' && o.orderStatus !== 'Returned');
    const paidPackages = packages.filter((p) => p.payment && p.payment.isReceived);

    /*
     * Memberships are counted from the MEMBERSHIPS THEMSELVES, not only from
     * Razorpay rows. A membership reaches a guest three ways:
     *   - app purchase  → a captured Payment (amount known)
     *   - clinic desk   → a captured Payment written by the admin grant (amount known)
     *   - Zenoti / legacy grant → no payment row at all (amount often unknown)
     * Counting payments alone reported "0 memberships, ₹0" while real members
     * existed, so members whose membership STARTED in the window are counted
     * too, priced from what the record knows and flagged when it knows nothing.
     */
    const membersStartedInRange = await User.find({
      ...userBranch,
      memberType: 'Zen Member',
      zenMembershipStartDate: { $gte: start, $lte: end },
    }).select('_id zenMembershipSource zenMembershipAmount zenMembershipPaymentStatus').lean();
    const paidMemberIds = new Set(membershipsScoped.map((p) => String(p.userId)));
    // A desk grant writes both a Payment and the user fields — count it once.
    const membersWithoutPayment = membersStartedInRange.filter((u) => !paidMemberIds.has(String(u._id)));
    const membershipAppRevenue = sum(membershipsScoped, (m) => m.amount)
      + sum(membersWithoutPayment.filter((u) => u.zenMembershipSource !== 'zenoti'), (u) => u.zenMembershipAmount);
    const membershipClinicRevenue = sum(membersWithoutPayment.filter((u) => u.zenMembershipSource === 'zenoti'), (u) => u.zenMembershipAmount);
    const membershipCount = membershipsScoped.length + membersWithoutPayment.length;
    // Zenoti's membership feed carries no price, and pre-2026 desk grants were
    // recorded without one — surface how many so ₹0 is never read as "no sales".
    const membershipsUnpriced = membersWithoutPayment.filter((u) => !(Number(u.zenMembershipAmount) > 0)).length;

    // ---- revenue by stream ------------------------------------------------
    const consultRev = sum(paidBookings.filter(isConsult), (x) => x.amount);
    const treatRev = sum(paidBookings.filter((x) => !isConsult(x)), (x) => x.amount);
    const clinicConsultRev = sum(paidBookings.filter((x) => x.source === 'zenoti' && isConsult(x)), (x) => x.amount);
    const clinicTreatRev = sum(paidBookings.filter((x) => x.source === 'zenoti' && !isConsult(x)), (x) => x.amount);
    const productRev = sum(paidOrders, (o) => o.pricing && o.pricing.total);
    const packageRev = sum(paidPackages, (p) => p.pricing && p.pricing.finalAmount);
    const membershipRev = sum(membershipsScoped, (m) => m.amount);

    // Clinic (Zenoti) retail + package sales live in the mirror, by sale date.
    const zMatch = branchName ? { branchName } : {};
    const [zOrders, zPackages] = await Promise.all([
      ZenotiGuestData.aggregate([
        { $match: zMatch }, { $unwind: '$orders' },
        { $addFields: { d: { $convert: { input: '$orders.saleDate', to: 'date', onError: null, onNull: null } } } },
        { $match: { d: { $gte: start, $lte: end } } },
        { $group: { _id: null, revenue: { $sum: { $ifNull: ['$orders.price', 0] } }, count: { $sum: 1 }, units: { $sum: { $ifNull: ['$orders.quantity', 1] } } } },
      ]),
      ZenotiGuestData.aggregate([
        { $match: zMatch }, { $unwind: '$packages' },
        { $addFields: { d: { $convert: { input: '$packages.purchaseDate', to: 'date', onError: null, onNull: null } } } },
        { $match: { d: { $gte: start, $lte: end } } },
        { $group: { _id: null, revenue: { $sum: { $ifNull: ['$packages.price', 0] } }, count: { $sum: 1 } } },
      ]),
    ]);
    const clinicProductRev = zOrders[0]?.revenue || 0;
    const clinicPackageRev = zPackages[0]?.revenue || 0;

    const streams = [
      { key: 'consultations', label: 'Consultations', revenue: round(consultRev), count: bookings.filter(isConsult).length, app: round(consultRev - clinicConsultRev), clinic: round(clinicConsultRev) },
      { key: 'treatments', label: 'Treatments', revenue: round(treatRev), count: bookings.filter((x) => !isConsult(x)).length, app: round(treatRev - clinicTreatRev), clinic: round(clinicTreatRev) },
      { key: 'products', label: 'Products', revenue: round(productRev + clinicProductRev), count: ordersScoped.length + (zOrders[0]?.count || 0), app: round(productRev), clinic: round(clinicProductRev) },
      { key: 'packages', label: 'Packages', revenue: round(packageRev + clinicPackageRev), count: packages.length + (zPackages[0]?.count || 0), app: round(packageRev), clinic: round(clinicPackageRev) },
      { key: 'memberships', label: 'Zen memberships', revenue: round(membershipAppRevenue + membershipClinicRevenue), count: membershipCount, app: round(membershipAppRevenue), clinic: round(membershipClinicRevenue), unpriced: membershipsUnpriced },
    ];
    const totalRevenue = round(streams.reduce((n, s) => n + s.revenue, 0));
    const prevMembers = await User.find({
      ...userBranch,
      memberType: 'Zen Member',
      zenMembershipStartDate: { $gte: prevStart, $lte: prevEnd },
    }).select('_id zenMembershipAmount').lean();
    const prevPaidMemberIds = new Set(prevMemberships.map((p) => String(p.userId)));
    const prevRevenue = round(sum(prevPaidBookings, (x) => x.amount) + sum(prevOrders, (o) => o.pricing && o.pricing.total) + sum(prevPackages, (p) => p.pricing && p.pricing.finalAmount)
      + sum(prevMemberships, (m) => m.amount)
      + sum(prevMembers.filter((u) => !prevPaidMemberIds.has(String(u._id))), (u) => u.zenMembershipAmount));
    // A previous window with nothing in it is "no comparable data", not a 0% drop.
    const prevHasData = prevPaidBookings.length + prevOrders.length + prevPackages.length + prevMemberships.length + prevMembers.length > 0;
    const growth = prevHasData && prevRevenue > 0 ? round(((totalRevenue - prevRevenue) / prevRevenue) * 100) : null;

    // ---- counts -----------------------------------------------------------
    const by = (arr, f) => arr.reduce((m, x) => { const k = f(x) || 'Other'; m[k] = (m[k] || 0) + 1; return m; }, {});
    const [newPatients, activeZen, zenExpiring, totalPatients] = await Promise.all([
      User.countDocuments({ ...userBranch, createdAt: { $gte: start, $lte: end } }),
      User.countDocuments({ ...userBranch, memberType: 'Zen Member', $or: [{ zenMembershipExpiryDate: null }, { zenMembershipExpiryDate: { $gte: new Date() } }] }),
      User.countDocuments({ ...userBranch, memberType: 'Zen Member', zenMembershipExpiryDate: { $gte: new Date(), $lte: new Date(Date.now() + 30 * 86400000) } }),
      User.countDocuments(userBranch),
    ]);
    const completed = bookings.filter((x) => x.status === 'Completed').length;
    const cancelled = bookings.filter((x) => x.status === 'Cancelled').length;
    const noShow = bookings.filter((x) => x.status === 'No Show').length;
    const counts = {
      bookings: bookings.length, completed, cancelled, noShow,
      consultations: bookings.filter(isConsult).length,
      treatments: bookings.filter((x) => !isConsult(x)).length,
      upcoming: bookings.filter((x) => ['Confirmed', 'Awaiting Confirmation', 'Rescheduled'].includes(x.status)).length,
      awaitingConfirmation: bookings.filter((x) => x.status === 'Awaiting Confirmation').length,
      noShowRate: bookings.length ? round((noShow / bookings.length) * 100) : 0,
      cancellationRate: bookings.length ? round((cancelled / bookings.length) * 100) : 0,
      orders: ordersScoped.length, paidOrders: paidOrders.length, ordersByStatus: by(ordersScoped, (o) => o.orderStatus),
      openOrders: ordersScoped.filter((o) => !['Delivered', 'Cancelled', 'Returned'].includes(o.orderStatus)).length,
      packagesAssigned: packages.length, packagesPaid: paidPackages.length,
      packagesUnpaid: packages.filter((p) => !(p.payment && p.payment.isReceived)).length,
      membershipsSold: membershipCount, membershipsUnpriced, activeZen, zenExpiring, newPatients, totalPatients,
      bookingsBySource: by(bookings, (x) => x.source || 'app'),
      outstanding: round(sum(bookings.filter((x) => x.paymentStatus === 'pending' && !['Cancelled', 'No Show'].includes(x.status)), (x) => x.amount)
        + sum(packages.filter((p) => !(p.payment && p.payment.isReceived) && p.status === 'Active'), (p) => p.pricing && p.pricing.finalAmount)),
      averageTicket: paidBookings.length + paidOrders.length + paidPackages.length + membershipsScoped.length
        ? round(totalRevenue / (paidBookings.length + paidOrders.length + paidPackages.length + membershipsScoped.length)) : 0,
    };

    // ---- dermatologist leaderboard ---------------------------------------
    const [docs, zenotiPractitioners] = await Promise.all([
      Doctor.find({ isActive: { $ne: false } }).select('doctorId name tier level designation photo').lean(),
      ZenotiPractitioner.find({}).select('zenotiEmployeeId name normalizedName onboardedDoctorId active').lean(),
    ]);
    const docByKey = new Map();
    docs.forEach((d) => { docByKey.set(String(d.doctorId).toLowerCase(), d); docByKey.set(String(d._id), d); docByKey.set(canonicalName(d.name), d); });
    const practitionerByEmployee = new Map(zenotiPractitioners.map((p) => [String(p.zenotiEmployeeId).toLowerCase(), p]));
    const practitionerByName = new Map(zenotiPractitioners.map((p) => [p.normalizedName || canonicalName(p.name), p]));
    const practitionerByLocal = new Map(zenotiPractitioners.filter((p) => p.onboardedDoctorId).map((p) => [String(p.onboardedDoctorId).toLowerCase(), p]));
    const perf = new Map();
    for (const bk of bookings) {
      const specialistKey = bk.specialistId && String(bk.specialistId).toLowerCase();
      const external = (bk.zenotiTherapistId && practitionerByEmployee.get(String(bk.zenotiTherapistId).toLowerCase()))
        || (bk.specialistName && practitionerByName.get(canonicalName(bk.specialistName)))
        || null;
      const linkedLocalId = external?.onboardedDoctorId && String(external.onboardedDoctorId).toLowerCase();
      const d = (specialistKey && docByKey.get(specialistKey))
        || (linkedLocalId && docByKey.get(linkedLocalId))
        || (bk.specialistName && docByKey.get(canonicalName(bk.specialistName)))
        || null;
      // Legacy Zenoti rows sometimes carried a treatment therapist in
      // specialistName. Only a verified employee-roster match or an explicitly
      // doctor-prefixed historical name may create a Zenoti leaderboard row.
      const validHistoricalName = Boolean(bk.specialistName)
        && (bk.source !== 'zenoti' || /^\s*dr\.?\s*/i.test(String(bk.specialistName)));
      if (!d && !external && !validHistoricalName) continue;
      const id = d
        ? String(d.doctorId)
        : external
          ? `zenoti:${external.zenotiEmployeeId}`
          : `zenoti-name:${canonicalName(bk.specialistName)}`;
      const source = d ? (practitionerByLocal.has(String(d.doctorId).toLowerCase()) ? 'app+zenoti' : 'app') : 'zenoti';
      const row = perf.get(id) || {
        doctorId: id, name: d ? d.name : external?.name || bk.specialistName, photo: d ? d.photo : null,
        tier: d ? d.tier : null, level: d ? (d.tier === 'senior-consultant' ? 'Senior Dermatologist' : 'Dermatologist') : 'Zenoti practitioner',
        source, onboarded: Boolean(d), zenotiEmployeeId: external?.zenotiEmployeeId || null,
        bookings: 0, consultations: 0, treatments: 0, completed: 0, noShow: 0, cancelled: 0, revenue: 0, ratings: [], patients: new Set(),
      };
      row.bookings += 1;
      if (isConsult(bk)) row.consultations += 1; else row.treatments += 1;
      if (bk.status === 'Completed') row.completed += 1;
      if (bk.status === 'No Show') row.noShow += 1;
      if (bk.status === 'Cancelled') row.cancelled += 1;
      if (bk.paymentStatus === 'paid') row.revenue += Number(bk.amount) || 0;
      if (bk.rating) row.ratings.push(bk.rating);
      if (bk.userId) row.patients.add(String(bk.userId));
      perf.set(id, row);
    }
    const dermatologists = [...perf.values()].map((r) => ({
      ...r, revenue: round(r.revenue), patients: r.patients.size,
      avgRating: r.ratings.length ? round(r.ratings.reduce((a, b) => a + b, 0) / r.ratings.length) : null,
      completionRate: r.bookings ? round((r.completed / r.bookings) * 100) : 0,
      ratings: undefined,
    })).sort((a, b) => b.revenue - a.revenue || b.completed - a.completed);
    // Dermatologists with no bookings in the window still belong on the board.
    docs.forEach((d) => {
      if (!perf.has(String(d.doctorId))) {
        const linked = practitionerByLocal.get(String(d.doctorId).toLowerCase());
        dermatologists.push({ doctorId: String(d.doctorId), name: d.name, photo: d.photo, tier: d.tier, level: d.tier === 'senior-consultant' ? 'Senior Dermatologist' : 'Dermatologist', source: linked ? 'app+zenoti' : 'app', onboarded: true, zenotiEmployeeId: linked?.zenotiEmployeeId || null, bookings: 0, consultations: 0, treatments: 0, completed: 0, noShow: 0, cancelled: 0, revenue: 0, patients: 0, avgRating: null, completionRate: 0 });
      }
    });
    // Active Zenoti doctors are useful reporting/filter dimensions even when
    // they had no visit in the selected period. They remain reporting-only.
    zenotiPractitioners.filter((p) => p.active && !p.onboardedDoctorId).forEach((p) => {
      const id = `zenoti:${p.zenotiEmployeeId}`;
      if (!perf.has(id)) dermatologists.push({ doctorId: id, name: p.name, photo: null, tier: null, level: 'Zenoti practitioner', source: 'zenoti', onboarded: false, zenotiEmployeeId: p.zenotiEmployeeId, bookings: 0, consultations: 0, treatments: 0, completed: 0, noShow: 0, cancelled: 0, revenue: 0, patients: 0, avgRating: null, completionRate: 0 });
    });

    // ---- services, centres, payment mix, series --------------------------
    const svcNames = new Map((await Consultation.find({ _id: { $in: [...new Set(paidBookings.concat(bookings).map((x) => x.consultationId).filter(Boolean).map(String))] } }).select('name category').lean()).map((c) => [String(c._id), c]));
    const svcAgg = new Map();
    for (const bk of bookings) {
      const c = bk.consultationId ? svcNames.get(String(bk.consultationId)) : null;
      const name = (c && c.name) || bk.externalServiceName || 'Other';
      const row = svcAgg.get(name) || { name, category: (c && c.category) || bk.externalServiceCategory || null, kind: isConsult(bk) ? 'consultation' : 'treatment', bookings: 0, revenue: 0 };
      row.bookings += 1;
      if (bk.paymentStatus === 'paid') row.revenue += Number(bk.amount) || 0;
      svcAgg.set(name, row);
    }
    const topServices = [...svcAgg.values()].map((r) => ({ ...r, revenue: round(r.revenue) })).sort((a, b) => b.revenue - a.revenue || b.bookings - a.bookings).slice(0, 10);

    const branches = await Branch.find({}).select('name').lean();
    const centreAgg = {};
    const bump = (name, amt, cnt = 1) => { const k = name || 'Unassigned'; centreAgg[k] = centreAgg[k] || { centre: k, revenue: 0, bookings: 0 }; centreAgg[k].revenue += amt; centreAgg[k].bookings += cnt; };
    const branchNameById = new Map(branches.map((x) => [String(x._id), x.name]));
    paidBookings.forEach((bk) => bump(bk.preferredLocation || branchNameById.get(String(bk.branchId)), Number(bk.amount) || 0, 0));
    bookings.forEach((bk) => bump(bk.preferredLocation || branchNameById.get(String(bk.branchId)), 0, 1));
    const revenueByCentre = Object.values(centreAgg).map((r) => ({ ...r, revenue: round(r.revenue) })).sort((a, b) => b.revenue - a.revenue);

    const payMix = {};
    const addPay = (m, amt) => { const k = m || 'Other'; payMix[k] = round((payMix[k] || 0) + amt); };
    paidBookings.forEach((bk) => addPay(bk.paymentMethod, Number(bk.amount) || 0));
    paidOrders.forEach((o) => addPay(o.paymentMethod === 'COD' ? 'Cash' : 'Razorpay', (o.pricing && o.pricing.total) || 0));
    paidPackages.forEach((p) => addPay(p.payment && p.payment.paymentMethod, (p.pricing && p.pricing.finalAmount) || 0));
    membershipsScoped.forEach((m) => addPay('Razorpay', m.amount || 0));

    const series = {};
    for (let i = 0; i < days; i += 1) { const d = new Date(start.getTime() + i * 86400000); series[dayKey(d)] = { date: dayKey(d), consultations: 0, treatments: 0, products: 0, packages: 0, memberships: 0, total: 0, bookings: 0 }; }
    const add = (date, key, amt) => { const row = series[dayKey(date)]; if (!row) return; row[key] = round(row[key] + amt); row.total = round(row.total + amt); };
    paidBookings.forEach((bk) => add(bk.paidAt || bk.createdAt, isConsult(bk) ? 'consultations' : 'treatments', Number(bk.amount) || 0));
    paidOrders.forEach((o) => add(o.createdAt, 'products', (o.pricing && o.pricing.total) || 0));
    paidPackages.forEach((p) => add((p.payment && p.payment.receivedDate) || p.createdAt, 'packages', (p.pricing && p.pricing.finalAmount) || 0));
    membershipsScoped.forEach((m) => add(m.createdAt, 'memberships', m.amount || 0));
    bookings.forEach((bk) => { const row = series[dayKey(bk.confirmedDate || bk.preferredDate)]; if (row) row.bookings += 1; });

    res.json({
      success: true,
      data: {
        period: { startDate: dayKey(start), endDate: dayKey(end), days, branch: branchName || 'All centres' },
        revenue: { total: totalRevenue, previous: prevRevenue, previousHasData: prevHasData, growthPercent: growth, streams },
        counts, dermatologists, topServices, revenueByCentre,
        paymentMix: Object.entries(payMix).map(([method, amount]) => ({ method, amount })).sort((a, b) => b.amount - a.amount),
        daily: Object.values(series),
      },
    });
  } catch (error) {
    console.error('❌ Dashboard analytics failed:', error);
    res.status(500).json({ success: false, message: 'Failed to build the dashboard' });
  }
};
