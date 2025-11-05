const express = require('express');
const router = express.Router();
const {
  getPrivacyPolicy,
  getTermsOfService,
  getHealthDataConsent
} = require('../controllers/privacyController');

// Public routes - accessible without authentication
router.get('/policy', getPrivacyPolicy);
router.get('/terms', getTermsOfService);
router.get('/health-consent', getHealthDataConsent);

module.exports = router;
