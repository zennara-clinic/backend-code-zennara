const express = require('express');
const router = express.Router();
const walkin = require('../controllers/walkinController');
const { protect, optionalAuth } = require('../middleware/auth');
const { walkInOtpLimiter } = require('../middleware/rateLimiter');

// Public — the desk tablet before anyone is signed in.
router.get('/branches', walkin.getBranches);
router.post('/send-otp', walkInOtpLimiter, walkin.sendOtp);
router.post('/verify-otp', walkInOtpLimiter, walkin.verifyOtp);

/*
 * Profile is the one endpoint that serves both a brand-new guest (authorised
 * by the walk-in proof in the body) and a returning one (authorised by the
 * session verify-otp just issued). optionalAuth attaches req.user when a
 * bearer is present and lets the request through when it is not; the handler
 * decides which of the two it is looking at.
 */
router.post('/profile', optionalAuth, walkin.saveProfile);

// Signed-in walk-in session.
router.get('/me', protect, walkin.me);
router.post('/preconsult', protect, walkin.submitPreConsult);
router.post('/finish', protect, walkin.finish);

module.exports = router;
