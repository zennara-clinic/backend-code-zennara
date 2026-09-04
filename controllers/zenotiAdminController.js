/**
 * Staff-side Zenoti endpoints for the unified panel (Panels/).
 *
 * Clinic customers imported from Zenoti are ordinary Users; these endpoints add
 * their CRM history (mirrored in ZenotiGuestData) so the panel can list
 * packages, appointments and memberships for every customer — app-native or
 * front-desk — without a per-customer search.
 */
const mongoose = require('mongoose');
const User = require('../models/User');
const Branch = require('../models/Branch');
const ZenotiGuestData = require('../models/ZenotiGuestData');
const ZenotiSyncRun = require('../models/ZenotiSyncRun');
const ZenotiPractitioner = require('../models/ZenotiPractitioner');
const Doctor = require('../models/Doctor');
const Booking = require('../models/Booking');
const importer = require('../services/zenotiImportService');
const appointmentSync = require('../services/zenotiAppointmentSyncService');
const practitionerSync = require('../services/zenotiPractitionerService');
const { canonicalName } = require('../utils/dermatologistMatch');
const logger = require('../utils/logger');
const { clinicDateKey, clinicParts } = (() => {
  const bookingTime = require('../utils/bookingTime');
  const parts = (value = new Date()) => {
    const date = value instanceof Date ? value : new Date(value);
    const rows = new Intl.DateTimeFormat('en-GB', {
      timeZone: bookingTime.CLINIC_TIME_ZONE,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(date);
    const get = (type) => rows.find((row) => row.type === type)?.value || '00';
    return { hour: get('hour') === '24' ? '00' : get('hour'), minute: get('minute'), second: get('second') };
  };
  return { clinicDateKey: bookingTime.clinicDateKey, clinicParts: parts };
})();

const clamp = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

/** Resolve `branchId` or `branch` (name) from the query into a branch name filter. */
async function branchNameFrom(query) {
  if (query.branch) return String(query.branch);
  if (query.branchId && mongoose.isValidObjectId(query.branchId)) {
    const b = await Branch.findById(query.branchId).select('name').lean();
    return b?.name || null;
  }
  return null;
}

const USER_FIELDS = 'patientId fullName email phone location memberType gender dateOfBirth source zenotiGuestId totalVisits totalSpent';

// GET /api/admin/zenoti/status
exports.getStatus = async (req, res) => {
  try {
    const status = await importer.getStatus();
    const history = await ZenotiSyncRun.find().sort({ startedAt: -1 }).limit(10).lean();
    res.json({ success: true, data: { ...status, history } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/admin/zenoti/import — roster + every supported patient dataset
exports.startImport = async (req, res) => {
  if (importer.isFullImportRunning() || importer.isRosterRunning() || importer.isDetailsRunning()) {
    return res.status(409).json({ success: false, message: 'A Zenoti import or history refresh is already running.' });
  }
  importer.fullImport({ trigger: 'manual', adminId: req.admin?._id }).catch((error) => {
    logger.error('Zenoti full import failed', { adminId: req.admin?._id, error: error.message });
  });
  logger.info('Zenoti full import started by admin', { adminId: req.admin?._id });
  res.status(202).json({
    success: true,
    message: 'Full import started: patients, profiles, treatments, purchases, packages, memberships, notes and forms.',
  });
};

// POST /api/admin/zenoti/crawl — sync the stalest N guests now
exports.startCrawl = async (req, res) => {
  if (importer.isFullImportRunning() || importer.isRosterRunning() || importer.isDetailsRunning()) {
    return res.status(409).json({ success: false, message: 'A Zenoti import or history refresh is already running.' });
  }
  const limit = clamp(req.body?.limit, 1, 200, 40);
  importer.crawlDetails({ limit, trigger: 'manual' }).catch(() => {});
  res.status(202).json({ success: true, message: `Refreshing the ${limit} least-recently synced customers.` });
};

// POST /api/admin/zenoti/appointments/sync — immediate working-diary refresh
exports.syncAppointments = async (_req, res) => {
  if (appointmentSync.isAppointmentSyncRunning()) {
    return res.status(409).json({ success: false, message: 'The live appointment refresh is already running.' });
  }
  appointmentSync.syncRecentAppointments({ trigger: 'manual' }).catch(() => {});
  return res.status(202).json({ success: true, message: 'Refreshing all clinic appointment books now.' });
};

// GET /api/admin/zenoti/catalog/services?branchId|branch — for the service mapping picker
exports.listCatalogServices = async (req, res) => {
  try {
    const { clinicCenterIdForBranch } = require('../config/zenoti');
    const zenoti = require('../services/zenotiService');
    const branchName = await branchNameFrom(req.query);
    const centerId = clinicCenterIdForBranch(branchName);
    const rows = await zenoti.getCenterServices(centerId);
    res.json({ success: true, data: rows.sort((a, b) => String(a.name).localeCompare(String(b.name))) });
  } catch (error) {
    res.status(502).json({ success: false, message: error.message });
  }
};

// GET /api/admin/zenoti/catalog/packages?branchId|branch — for the package mapping picker
exports.listCatalogPackages = async (req, res) => {
  try {
    const { clinicCenterIdForBranch } = require('../config/zenoti');
    const zenoti = require('../services/zenotiService');
    const branchName = await branchNameFrom(req.query);
    const centerId = clinicCenterIdForBranch(branchName);
    const rows = (await zenoti.getCenterPackages(centerId)).filter((p) => p.active);
    res.json({ success: true, data: rows.sort((a, b) => String(a.name).localeCompare(String(b.name))) });
  } catch (error) {
    res.status(502).json({ success: false, message: error.message });
  }
};

/**
 * GET /api/admin/zenoti/readiness — can what is created here actually reach
 * Zenoti? One honest checklist instead of silent 'skipped' rows.
 */
let readinessCache = { at: 0, data: null };
exports.getReadiness = async (_req, res) => {
  try {
    if (readinessCache.data && Date.now() - readinessCache.at < 5 * 60 * 1000) return res.json({ success: true, data: readinessCache.data });
    const zenoti = require('../services/zenotiService');
    const zenotiWrite = require('../services/zenotiWriteService');
    const { CENTERS } = require('../config/zenoti');
    const Consultation = require('../models/Consultation');
    const Package = require('../models/Package');
    const clinics = Object.entries(CENTERS).filter(([, c]) => c.isClinic);
    const Doctor = require('../models/Doctor');
    const ZenotiPractitioner = require('../models/ZenotiPractitioner');
    const [consultations, packages, doctors, practitioners] = await Promise.all([
      Consultation.find({ isActive: { $ne: false } }).select('name slug category zenotiServiceId').lean(),
      Package.find({ isActive: { $ne: false } }).select('name zenotiPackageId').lean(),
      Doctor.find({ isActive: { $ne: false } }).select('name doctorId').lean(),
      ZenotiPractitioner.find({ active: true, onboardedDoctorId: { $ne: null } }).select('onboardedDoctorId').lean(),
    ]);
    // A confirmed booking names its dermatologist; Zenoti needs that person as
    // an employee id, or the appointment is refused. This is the commonest
    // reason a booking shows "Not in Zenoti".
    const linked = new Set(practitioners.map((p) => String(p.onboardedDoctorId || '').toLowerCase()));
    const unlinkedDermatologists = doctors
      .filter((d) => !linked.has(String(d.doctorId || '').toLowerCase()))
      .map((d) => d.name);
    const perClinic = await Promise.all(clinics.map(async ([centerId, c]) => {
      const [schedules, services, catalogPackages] = await Promise.all([
        zenoti.getCenterEmployeeSchedules(centerId).catch(() => null),
        zenoti.getCenterServices(centerId).catch(() => []),
        zenoti.getCenterPackages(centerId).catch(() => []),
      ]);
      const shifts = schedules ? schedules.flatMap((e) => e.shifts) : [];
      const working = shifts.filter((sft) => Number(sft.status) === 0).length;
      let resolvedServices = 0;
      for (const item of consultations) if (await zenotiWrite.resolveServiceId(centerId, item)) resolvedServices += 1;
      let resolvedPackages = 0;
      for (const item of packages) if (await zenotiWrite.resolvePackageId(centerId, item)) resolvedPackages += 1;
      return {
        centerId, name: c.name,
        schedulesPublished: schedules ? working > 0 : null,
        shiftsWorking: working, shiftsTotal: shifts.length,
        servicesInCatalogue: services.length, bookableServices: services.filter((x) => x.canBook).length,
        servicesResolved: resolvedServices, servicesTotal: consultations.length,
        packagesResolved: resolvedPackages, packagesTotal: packages.length, zenotiPackages: catalogPackages.length,
      };
    }));
    const data = {
      writeMode: zenotiWrite.mode(),
      lifecycleWriteback: zenotiWrite.lifecycleWritebackEnabled(),
      breaker: zenotiWrite.breakerStatus(),
      updatedByConfigured: Boolean(process.env.ZENOTI_UPDATED_BY_ID),
      referralSourceConfigured: Boolean(process.env.ZENOTI_REFERRAL_SOURCE_ID),
      unmappedServices: consultations.filter((c) => !c.zenotiServiceId).map((c) => c.name),
      unmappedPackages: packages.filter((p) => !p.zenotiPackageId).map((p) => p.name),
      unlinkedDermatologists,
      clinics: perClinic,
      checkedAt: new Date(),
    };
    readinessCache = { at: Date.now(), data };
    res.json({ success: true, data });
  } catch (error) {
    res.status(502).json({ success: false, message: error.message });
  }
};

// POST /api/admin/zenoti/publish-doctor-hours  { days?, doctorId?, dryRun? }
exports.publishDoctorHours = async (req, res) => {
  try {
    const svc = require('../services/zenotiScheduleWriteService');
    const summary = await svc.publishDoctorHours({
      days: clamp(req.body?.days, 1, 62, svc.HORIZON_DAYS),
      doctorId: req.body?.doctorId || null,
      dryRun: req.body?.dryRun === true,
      trigger: 'manual',
    });
    logger.info('Dermatologist hours publish requested', { adminId: req.admin?._id, dryRun: summary.dryRun, written: summary.written });
    res.json({ success: true, data: summary });
  } catch (error) {
    res.status(502).json({ success: false, message: error.message });
  }
};

// POST /api/admin/zenoti/write-breaker/reset
exports.resetWriteBreaker = async (req, res) => {
  require('../services/zenotiWriteService').resetBreaker();
  logger.warn('Zenoti write breaker reset', { adminId: req.admin?._id });
  res.json({ success: true, data: require('../services/zenotiWriteService').breakerStatus() });
};

// GET /api/admin/zenoti/practitioners
// Unified reporting/filter dimension. Onboarded doctors remain the only rows
// exposed by /api/doctors and therefore the only doctors visible in the app.
exports.listPractitioners = async (_req, res) => {
  try {
    const [doctors, external, historical] = await Promise.all([
      Doctor.find({ isActive: { $ne: false } }).select('doctorId name availableCentres photo tier').sort({ name: 1 }).lean(),
      ZenotiPractitioner.find({ active: true }).sort({ name: 1 }).lean(),
      Booking.aggregate([
        { $match: { source: 'zenoti', specialistName: /^\s*dr\.?\s*/i } },
        { $group: {
          _id: { employeeId: '$zenotiTherapistId', name: '$specialistName' },
          bookings: { $sum: 1 },
          revenue: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'paid'] }, { $ifNull: ['$amount', 0] }, 0] } },
          lastVisit: { $max: { $ifNull: ['$confirmedDate', '$preferredDate'] } },
        } },
      ]),
    ]);

    const externalByLocal = new Map();
    external.forEach((row) => {
      if (row.onboardedDoctorId) externalByLocal.set(String(row.onboardedDoctorId), row);
    });
    const rows = doctors.map((doctor) => {
      const linked = externalByLocal.get(String(doctor.doctorId));
      return {
        filterValue: doctor.doctorId,
        name: doctor.name,
        source: linked ? 'app+zenoti' : 'app',
        onboarded: true,
        doctorId: doctor.doctorId,
        zenotiEmployeeId: linked?.zenotiEmployeeId || null,
        centers: [...new Set([...(doctor.availableCentres || []), ...(linked?.centerNames || [])])],
      };
    });
    const seen = new Set();
    rows.forEach((row) => {
      seen.add(row.filterValue);
      // A linked Zenoti identity must not reappear as a second historical row.
      if (row.zenotiEmployeeId) seen.add(`zenoti:${String(row.zenotiEmployeeId).toLowerCase()}`);
    });

    external.filter((row) => !row.onboardedDoctorId).forEach((row) => {
      const filterValue = `zenoti:${row.zenotiEmployeeId}`;
      if (seen.has(filterValue)) return;
      seen.add(filterValue);
      rows.push({
        filterValue,
        name: row.name,
        source: 'zenoti',
        onboarded: false,
        doctorId: null,
        zenotiEmployeeId: row.zenotiEmployeeId,
        centers: row.centerNames || [],
      });
    });

    // Keep former/visiting Zenoti doctors selectable for historical reports,
    // even when they are no longer in today's active employee roster.
    historical.forEach((item) => {
      const employeeId = item._id.employeeId && String(item._id.employeeId).toLowerCase();
      const filterValue = employeeId ? `zenoti:${employeeId}` : `zenoti-name:${canonicalName(item._id.name)}`;
      if (!canonicalName(item._id.name) || seen.has(filterValue)) return;
      seen.add(filterValue);
      rows.push({
        filterValue,
        name: item._id.name,
        source: 'zenoti',
        onboarded: false,
        doctorId: null,
        zenotiEmployeeId: employeeId || null,
        centers: [],
        historical: true,
        bookings: item.bookings,
        revenue: item.revenue,
        lastVisit: item.lastVisit,
      });
    });

    rows.sort((a, b) => Number(b.onboarded) - Number(a.onboarded) || a.name.localeCompare(b.name));
    res.json({ success: true, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/admin/zenoti/practitioners/:employeeId/onboard — create the app
// dermatologist for a Zenoti doctor and link the two identities.
exports.onboardPractitioner = async (req, res) => {
  try {
    const row = await ZenotiPractitioner.findOne({ zenotiEmployeeId: String(req.params.employeeId).toLowerCase() });
    if (!row) return res.status(404).json({ success: false, message: 'Zenoti doctor not found' });
    if (row.onboardedDoctorId) return res.status(409).json({ success: false, message: `Already linked to ${row.onboardedDoctorId}` });
    const name = String(req.body?.name || row.name).replace(/^\s*dr\.?\s*/i, '').replace(/\s*\.\s*$/, '').trim();
    const doctorController = require('./doctorController');
    let created = null;
    const fakeRes = { status(code) { this.code = code; return this; }, json(body) { created = { code: this.code || 200, body }; } };
    await doctorController.createDoctor({
      admin: req.admin,
      body: {
        name,
        tier: req.body?.tier || (require('../models/Doctor').schema.path('tier').enumValues || []).find((t) => !/senior/i.test(t)) || 'dermatologist',
        availableCentres: Array.isArray(req.body?.availableCentres) && req.body.availableCentres.length ? req.body.availableCentres : row.centerNames,
        email: req.body?.email || undefined,
        password: req.body?.password || undefined,
        isActive: true,
      },
    }, fakeRes);
    if (!created || created.code >= 400) return res.status(created?.code || 500).json(created?.body || { success: false, message: 'Could not create the dermatologist' });
    const doctor = created.body?.data;
    row.onboardedDoctorId = doctor?.doctorId || null;
    await row.save();
    logger.info('Zenoti doctor onboarded as app dermatologist', { adminId: req.admin?._id, employeeId: row.zenotiEmployeeId, doctorId: row.onboardedDoctorId });
    res.status(201).json({ success: true, data: { doctor, practitioner: row } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/admin/zenoti/practitioners/sync
exports.syncPractitioners = async (_req, res) => {
  if (practitionerSync.isRunning()) return res.status(409).json({ success: false, message: 'The practitioner roster is already refreshing.' });
  try {
    const result = await practitionerSync.syncPractitioners({ trigger: 'manual' });
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(502).json({ success: false, message: error.message });
  }
};

// GET /api/admin/zenoti/users/:userId  (?refresh=1 forces a live pull)
exports.getUserData = async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).select(USER_FIELDS + ' zenotiCenterId zenotiSyncedAt').lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (!user.zenotiGuestId) {
      return res.json({ success: true, data: { user, linked: false, details: null } });
    }
    const details = await importer.getGuestDetails(user, { refresh: req.query.refresh === '1' });
    res.json({ success: true, data: { user, linked: true, details } });
  } catch (error) {
    logger.error('Zenoti user data failed', { error: error.message });
    res.status(502).json({ success: false, message: 'Could not load this customer\'s clinic history right now.' });
  }
};

// POST /api/admin/zenoti/users/:userId/sync
exports.syncUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (!user.zenotiGuestId) return res.status(400).json({ success: false, message: 'This account is not linked to a Zenoti guest.' });
    const details = await importer.syncGuestDetails(user);
    res.json({ success: true, data: { user: user.toObject(), linked: true, details } });
  } catch (error) {
    res.status(502).json({ success: false, message: error.message });
  }
};

/**
 * Shared list builder: unwind one array field of ZenotiGuestData, join the
 * user, filter, sort and page. Returns { rows, total }.
 */
async function listUnwound(field, { match = {}, sort, page, limit, branchName, search }) {
  const pipeline = [];
  if (branchName) pipeline.push({ $match: { branchName } });
  pipeline.push({ $unwind: `$${field}` });
  pipeline.push({ $match: match });
  pipeline.push({
    $lookup: {
      from: 'users', localField: 'userId', foreignField: '_id', as: 'user',
      pipeline: [{ $project: {
        patientId: 1, fullName: 1, phone: 1, location: 1, memberType: 1, source: 1,
        // Placeholder addresses are internal keys, not something staff should see.
        email: { $cond: [{ $regexMatch: { input: { $ifNull: ['$email', ''] }, regex: /@guest\.zennara\.in$|@zennara\.local$/i } }, null, '$email'] },
      } }],
    },
  });
  pipeline.push({ $unwind: '$user' });
  if (search) {
    const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    pipeline.push({ $match: { $or: [
      { 'user.fullName': rx }, { 'user.phone': rx }, { 'user.email': rx },
      { [`${field}.name`]: rx }, { [`${field}.serviceName`]: rx }, { [`${field}.text`]: rx },
    ] } });
  }
  pipeline.push({ $project: { _id: 0, userId: 1, branchName: 1, user: 1, item: `$${field}`, syncedAt: 1 } });
  pipeline.push({ $sort: sort });
  pipeline.push({ $facet: { rows: [{ $skip: (page - 1) * limit }, { $limit: limit }], total: [{ $count: 'n' }] } });
  const [out] = await ZenotiGuestData.aggregate(pipeline);
  return { rows: out?.rows ?? [], total: out?.total?.[0]?.n ?? 0 };
}

// GET /api/admin/zenoti/packages?status=active|expired|all&branchId&search&page&limit
exports.listPackages = async (req, res) => {
  try {
    const page = clamp(req.query.page, 1, 1e6, 1);
    const limit = clamp(req.query.limit, 1, 200, 50);
    const branchName = await branchNameFrom(req.query);
    const status = req.query.status || 'active';
    const now = new Date().toISOString();
    const match = {};
    if (status === 'active') {
      match.$and = [
        { 'packages.status': { $in: [1, '1', 'active', 'Active'] } },
        { 'packages.sessionsRemaining': { $gt: 0 } },
        { $or: [{ 'packages.neverExpires': true }, { 'packages.endDate': null }, { 'packages.endDate': { $gte: now } }] },
      ];
    } else if (status === 'expired') {
      match.$or = [{ 'packages.sessionsRemaining': { $lte: 0 } }, { $and: [{ 'packages.neverExpires': { $ne: true } }, { 'packages.endDate': { $lt: now } }] }];
    }
    const { rows, total } = await listUnwound('packages', {
      match, page, limit, branchName, search: req.query.search,
      sort: { 'item.purchaseDate': -1 },
    });
    const summary = await ZenotiGuestData.aggregate([
      ...(branchName ? [{ $match: { branchName } }] : []),
      { $group: { _id: null, activePackages: { $sum: '$stats.activePackages' }, sessionsLeft: { $sum: '$stats.sessionsLeft' }, customers: { $sum: { $cond: [{ $gt: ['$stats.activePackages', 0] }, 1, 0] } } } },
    ]);
    res.json({ success: true, data: rows, total, page, limit, summary: summary[0] || { activePackages: 0, sessionsLeft: 0, customers: 0 } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/admin/zenoti/appointments?from&to&branchId&search&page&limit&upcoming=1
exports.listAppointments = async (req, res) => {
  try {
    const page = clamp(req.query.page, 1, 1e6, 1);
    const limit = clamp(req.query.limit, 1, 200, 50);
    const branchName = await branchNameFrom(req.query);
    const match = {};
    const range = {};
    // Zenoti mirror values are clinic wall-clock strings without an offset.
    // Compare like with like; converting a date filter to UTC shifted the
    // boundary and put a 1 September appointment under 2 September.
    if (/^\d{4}-\d{2}-\d{2}/.test(req.query.from || '')) range.$gte = `${String(req.query.from).slice(0, 10)}T00:00:00`;
    if (/^\d{4}-\d{2}-\d{2}/.test(req.query.to || '')) range.$lte = `${String(req.query.to).slice(0, 10)}T23:59:59.999`;
    if (req.query.upcoming === '1') {
      const now = new Date();
      const clock = clinicParts(now);
      range.$gte = `${clinicDateKey(now)}T${clock.hour}:${clock.minute}:${clock.second}`;
    }
    if (Object.keys(range).length) match['appointments.startTime'] = range;
    const { rows, total } = await listUnwound('appointments', {
      match, page, limit, branchName, search: req.query.search,
      sort: req.query.upcoming === '1' ? { 'item.startTime': 1 } : { 'item.startTime': -1 },
    });
    res.json({ success: true, data: rows, total, page, limit });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/admin/zenoti/memberships?status=active|all&branchId&search&page&limit
exports.listMemberships = async (req, res) => {
  try {
    const page = clamp(req.query.page, 1, 1e6, 1);
    const limit = clamp(req.query.limit, 1, 200, 50);
    const branchName = await branchNameFrom(req.query);
    const activeOnly = (req.query.status || 'active') === 'active';
    const match = activeOnly ? {
      $and: [
        { 'memberships.status': { $in: [1, '1', 'active', 'Active'] } },
        { $or: [{ 'memberships.expiryDate': null }, { 'memberships.expiryDate': { $gte: new Date().toISOString() } }] },
      ],
    } : {};
    const { rows, total } = await listUnwound('memberships', {
      match, page, limit, branchName, search: req.query.search,
      sort: { 'item.expiryDate': -1 },
    });
    res.json({ success: true, data: rows, total, page, limit });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/admin/zenoti/orders?branchId&search&page&limit
exports.listOrders = async (req, res) => {
  try {
    const page = clamp(req.query.page, 1, 1e6, 1);
    const limit = clamp(req.query.limit, 1, 200, 50);
    const branchName = await branchNameFrom(req.query);
    const { rows, total } = await listUnwound('orders', {
      match: {}, page, limit, branchName, search: req.query.search,
      sort: { 'item.saleDate': -1 },
    });
    res.json({ success: true, data: rows, total, page, limit });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/admin/zenoti/notes?branchId&search&page&limit
exports.listNotes = async (req, res) => {
  try {
    const page = clamp(req.query.page, 1, 1e6, 1);
    const limit = clamp(req.query.limit, 1, 200, 50);
    const branchName = await branchNameFrom(req.query);
    const { rows, total } = await listUnwound('notes', {
      match: {}, page, limit, branchName, search: req.query.search,
      sort: { 'item.createdAt': -1 },
    });
    res.json({ success: true, data: rows, total, page, limit });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/admin/zenoti/forms?branchId&search&page&limit
exports.listForms = async (req, res) => {
  try {
    const page = clamp(req.query.page, 1, 1e6, 1);
    const limit = clamp(req.query.limit, 1, 200, 50);
    const branchName = await branchNameFrom(req.query);
    const { rows, total } = await listUnwound('forms', {
      match: {}, page, limit, branchName, search: req.query.search,
      sort: { 'item.lastFilledAt': -1 },
    });
    res.json({ success: true, data: rows, total, page, limit });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/**
 * POST /api/admin/zenoti/products/sync — run the catalogue/stock mirror now.
 * Read-only against Zenoti; see services/zenotiProductSyncService.js.
 */
exports.syncProducts = async (req, res) => {
  try {
    const stats = await require('../services/zenotiProductSyncService')
      .syncProducts({ trigger: `admin:${req.admin?.email || 'unknown'}` });
    return res.json({ success: true, data: stats });
  } catch (error) {
    console.error('Zenoti product sync failed:', error);
    return res.status(500).json({ success: false, message: error.message || 'Product sync failed' });
  }
};

/** POST /api/admin/zenoti/catalog/sync — mirror services + packages now. */
exports.syncCatalog = async (req, res) => {
  try {
    const stats = await require('../services/zenotiCatalogSyncService')
      .syncCatalog({ trigger: 'manual', adminId: req.admin?._id || null });
    return res.json({ success: true, data: stats });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Catalogue sync failed' });
  }
};

/**
 * GET /api/admin/zenoti/sync-health
 *
 * One screen that answers "is everything flowing, both ways?": the last run of
 * every inbound mirror with its cadence, and everything outbound that is still
 * waiting on Zenoti. This is what to look at before and after any deploy.
 */
exports.syncHealth = async (_req, res) => {
  try {
    const ZenotiSyncRun = require('../models/ZenotiSyncRun');
    const Booking = require('../models/Booking');
    const User = require('../models/User');
    const PackageAssignment = require('../models/PackageAssignment');
    const ConsultationNote = require('../models/ConsultationNote');
    const zenotiWrite = require('../services/zenotiWriteService');

    const MIRRORS = [
      { type: 'appointments', label: 'Appointments (Zenoti → Zennara)', every: 'every 2 min (next 6 days) + every 15 min (up to 62 days)' },
      { type: 'roster', label: 'Guests roster (Zenoti → Zennara)', every: 'nightly 02:30 IST' },
      { type: 'details', label: 'Guest histories (Zenoti → Zennara)', every: 'every 5 min, 40 guests' },
      { type: 'products', label: 'Products & stock (Zenoti → Zennara)', every: 'hourly at :20' },
      { type: 'catalog', label: 'Services & packages (Zenoti → Zennara)', every: 'hourly at :40' },
    ];
    const inbound = await Promise.all(MIRRORS.map(async (m) => {
      const last = await ZenotiSyncRun.findOne({ type: m.type }).sort({ startedAt: -1 }).lean();
      return { ...m, last: last ? {
        status: last.status, startedAt: last.startedAt, finishedAt: last.finishedAt,
        created: last.created, updated: last.updated, failed: last.failed, error: last.error,
        datasets: last.datasets,
      } : null };
    }));

    const now = new Date();
    const [bookingsPending, bookingsFailed, bookingsNeedPerson, usersPending, usersFailed, usersReview, pkgPending, notesFailed] = await Promise.all([
      Booking.countDocuments({ source: { $in: ['app', 'reception'] }, status: 'Confirmed', zenotiAppointmentId: null, zenotiBookingId: null, zenotiSyncStatus: { $in: ['pending', 'failed', null] }, eventAt: { $gte: now } }),
      Booking.countDocuments({ source: { $in: ['app', 'reception'] }, zenotiSyncStatus: 'failed', eventAt: { $gte: now } }),
      Booking.countDocuments({ source: { $in: ['app', 'reception'] }, zenotiAppointmentId: null, zenotiBookingId: { $ne: null }, eventAt: { $gte: now } }),
      User.countDocuments({ zenotiGuestId: { $exists: false }, zenotiSyncStatus: 'pending' }),
      User.countDocuments({ zenotiSyncStatus: 'failed' }),
      User.countDocuments({ zenotiSyncStatus: 'review' }),
      PackageAssignment.countDocuments({ zenotiSyncStatus: { $in: ['pending', 'failed'] } }),
      ConsultationNote.countDocuments({ zenotiSyncStatus: 'failed' }),
    ]);

    return res.json({ success: true, data: {
      checkedAt: now,
      writeMode: zenotiWrite.mode(),
      lifecycleWriteback: zenotiWrite.lifecycleWritebackEnabled(),
      breaker: zenotiWrite.breakerStatus(),
      inbound,
      outbound: {
        bookingsAwaitingPush: bookingsPending,
        bookingsFailed,
        bookingsNeedingAPerson: bookingsNeedPerson,
        patientsPendingSync: usersPending,
        patientsSyncFailed: usersFailed,
        patientsNeedingReview: usersReview,
        packageSalesPending: pkgPending,
        prescriptionNotesFailed: notesFailed,
        retry: 'confirmed future bookings retried every 10 min, max 10 per run',
      },
    } });
  } catch (error) {
    console.error('syncHealth failed:', error);
    return res.status(500).json({ success: false, message: 'Could not build the sync health view' });
  }
};
