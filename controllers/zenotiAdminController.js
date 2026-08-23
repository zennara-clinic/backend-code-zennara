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
const importer = require('../services/zenotiImportService');
const { isMembershipCurrentlyActive } = require('../services/zenotiSyncService');
const logger = require('../utils/logger');

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

// POST /api/admin/zenoti/import — start a roster import in the background
exports.startImport = async (req, res) => {
  if (importer.isRosterRunning()) {
    return res.status(409).json({ success: false, message: 'A roster import is already running.' });
  }
  importer.importRoster({ trigger: 'manual', adminId: req.admin?._id }).catch(() => {});
  logger.info('Zenoti roster import started by admin', { adminId: req.admin?._id });
  res.status(202).json({ success: true, message: 'Import started. Guests will appear in Patients as they are mirrored.' });
};

// POST /api/admin/zenoti/crawl — sync the stalest N guests now
exports.startCrawl = async (req, res) => {
  if (importer.isDetailsRunning()) {
    return res.status(409).json({ success: false, message: 'A history sync is already running.' });
  }
  const limit = clamp(req.body?.limit, 1, 200, 40);
  importer.crawlDetails({ limit, trigger: 'manual' }).catch(() => {});
  res.status(202).json({ success: true, message: `Refreshing the ${limit} least-recently synced customers.` });
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
      pipeline: [{ $project: { patientId: 1, fullName: 1, email: 1, phone: 1, location: 1, memberType: 1, source: 1 } }],
    },
  });
  pipeline.push({ $unwind: '$user' });
  if (search) {
    const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    pipeline.push({ $match: { $or: [{ 'user.fullName': rx }, { 'user.phone': rx }, { 'user.email': rx }, { [`${field}.name`]: rx }, { [`${field}.serviceName`]: rx }] } });
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
    if (req.query.from) range.$gte = new Date(req.query.from).toISOString();
    if (req.query.to) { const t = new Date(req.query.to); t.setHours(23, 59, 59, 999); range.$lte = t.toISOString(); }
    if (req.query.upcoming === '1') range.$gte = new Date().toISOString();
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
    const { rows, total } = await listUnwound('memberships', {
      match: {}, page: 1, limit: 5000, branchName, search: req.query.search,
      sort: { 'item.expiryDate': -1 },
    });
    const wanted = (req.query.status || 'active') === 'active' ? rows.filter((r) => isMembershipCurrentlyActive(r.item)) : rows;
    const start = (page - 1) * limit;
    res.json({ success: true, data: wanted.slice(start, start + limit), total: wanted.length || total, page, limit });
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
