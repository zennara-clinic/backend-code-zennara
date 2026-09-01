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

// All routes are admin-protected
router.use(protectAdmin);

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
  require('../controllers/dashboardController').getDashboard,
);
router.get('/inventory', requirePermission('inventory.view', 'analytics.view'), getInventoryAnalytics);

// Clinic-wide numbers belong to the admin panel, not clinical/floor logins.
router.use(requirePermission('analytics.view'));

// Financial analytics
router.get('/financial', getFinancialAnalytics);
router.get('/revenue/monthly', getMonthlyRevenueTrend);
router.get('/target/daily', getDailyTargetProgress);

// Patient analytics
router.get('/patients', getPatientAnalytics);
router.get('/patients/acquisition', getPatientAcquisitionTrend);
router.get('/patients/top', getTopPatients);
router.get('/patients/demographics', getPatientDemographics);
router.get('/patients/sources', getPatientSources);

// Birthday wishes
router.post('/patients/:userId/birthday-wish', sendBirthdayWish);

// Appointment analytics
router.get('/appointments', getAppointmentAnalytics);

// Service analytics
router.get('/services', getServiceAnalytics);

module.exports = router;
