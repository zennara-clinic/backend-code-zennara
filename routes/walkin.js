const express = require('express');
const router = express.Router();
const walkin = require('../controllers/walkinController');
const { protect, optionalAuth } = require('../middleware/auth');
const {
  walkInOtpLimiter,
  walkInOtpSourceLimiter,
  walkInFormLimiter,
} = require('../middleware/rateLimiter');

// Public — the desk tablet before anyone is signed in.
router.get('/branches', walkin.getBranches);
/*
 * Two ceilings on the OTP, because one number cannot see both abuses.
 *
 * walkInOtpLimiter counts FAILED attempts per phone number: it is what stops
 * someone grinding codes against one guest, and keying it on the number rather
 * than the address is what stopped a busy desk — the whole clinic shares one
 * connection — from locking itself out after a dozen honest check-ins.
 * walkInOtpSourceLimiter is the other half: a caller walking through thousands
 * of DIFFERENT numbers stays inside every per-number budget while sending a
 * paid WhatsApp message to each, in the clinic's name.
 */
router.post('/send-otp', walkInOtpSourceLimiter, walkInOtpLimiter, walkin.sendOtp);
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
// A signed form is one submission, not a loop: the signature is a data URI the
// guest's own session could otherwise post as fast as the network allows.
router.post('/preconsult', protect, walkInFormLimiter, walkin.submitPreConsult);
router.post('/finish', protect, walkin.finish);

module.exports = router;
