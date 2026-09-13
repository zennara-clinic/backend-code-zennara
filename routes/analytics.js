const express = require('express');
const router = express.Router();
const {
  getFinancialAnalytics,
  getMonthlyRevenueTrend,
  getDailyTargetProgress,
  getPatientAnalytics,
  getPatientAcquisitionTrend,
  getTopPatients,
  getPatientDemographics,
  getPatientSources,
  sendBirthdayWish,
  getAppointmentAnalytics,
  getServiceAnalytics,
  getInventoryAnalytics
} = require('../controllers/analyticsController');
const { protectAdmin, requirePermission } = require('../middleware/auth');
const responseCache = require('../utils/responseCache');

// All routes are admin-protected
router.use(protectAdmin);

/*
 * Every report below is served from a 60-second in-process cache (see
 * utils/responseCache): the Analytics page fires fourteen of these at once on
 * every load and every range flip, and the numbers move slowly. The key is the
 * full URL plus the caller's scope, so a centre-pinned login never reads
 * another scope's answer. The cache sits AFTER each permission gate, so a
 * caller without the permission never sees a cached body either.
 *
 * Deliberately NOT cached: /sales/today and /daily-summary — the desk reads
 * those live, and /daily-summary?send=true has a side effect.
 */
const cached = responseCache.cacheFor(60);

/*
 * Two endpoints are declared before the blanket `analytics.view` gate because
 * they are not the Analytics page — they back screens with their own permission:
 *
 *  - /dashboard is what the Overview page renders. Gating it on `analytics.view`
 *    meant a role granted "Overview dashboard" opened the page and got a 403
 *    from its only request.
 *  - /inventory feeds the sidebar's low-stock badge on the Stock pages.
 *
 * Everything below is the Analytics & reports page proper.
 */
router.get(
  '/dashboard',
  requirePermission('overview.view', 'analytics.view'),
  cached,
  require('../controllers/dashboardController').getDashboard,
);
router.get('/inventory', requirePermission('inventory.view', 'analytics.view'), cached, getInventoryAnalytics);
// The desk's "Today's sales" register (visits, orders, packages paid on a day).
router.get('/sales/today', requirePermission('today.view', 'bookings.view', 'analytics.view'), require('../controllers/analyticsController').getTodaysSales);
router.get('/sales/by-staff', requirePermission('analytics.view', 'billing.view'), cached, require('../controllers/analyticsController').getSalesByStaff);
// Preview (or send now) the automated 20:00 IST clinic summary.
router.get(
  '/daily-summary',
  requirePermission('overview.view', 'analytics.view'),
  require('../controllers/dashboardController').dailySummary,
);

// Clinic-wide numbers belong to the admin panel, not clinical/floor logins.
router.use(requirePermission('analytics.view'));

// Financial analytics
router.get('/financial', cached, getFinancialAnalytics);
router.get('/revenue/monthly', cached, getMonthlyRevenueTrend);
router.get('/target/daily', cached, getDailyTargetProgress);

// Patient analytics
router.get('/patients', cached, getPatientAnalytics);
router.get('/patients/acquisition', cached, getPatientAcquisitionTrend);
router.get('/patients/top', cached, getTopPatients);
router.get('/patients/demographics', cached, getPatientDemographics);
router.get('/patients/sources', cached, getPatientSources);

// Birthday wishes
router.post('/patients/:userId/birthday-wish', sendBirthdayWish);

// Appointment analytics
router.get('/appointments', cached, getAppointmentAnalytics);

// Service analytics
router.get('/services', cached, getServiceAnalytics);

// Forget every cached report now — after an import, a correction, or when a
// figure on screen must reflect a change made seconds ago.
router.post('/cache/clear', (req, res) => {
  const cleared = responseCache.clear();
  res.json({ success: true, data: { cleared, ...responseCache.stats() } });
});

module.exports = router;
