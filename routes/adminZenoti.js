const express = require('express');
const router = express.Router();
const { protectAdmin } = require('../middleware/auth');
const { adminGuestOverview } = require('../controllers/zenotiController');

// Staff-only view of a customer's Zenoti data for the unified panel (Panels/).
// This is the authorised way for clinic staff to inspect a customer's records —
// no customer-app impersonation, no OTP handling.
router.get('/overview', protectAdmin, adminGuestOverview);

module.exports = router;
