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
const { protectAdmin } = require('../middleware/auth');

// All routes are admin-protected
router.use(protectAdmin);

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

// Inventory analytics
router.get('/inventory', getInventoryAnalytics);

module.exports = router;
