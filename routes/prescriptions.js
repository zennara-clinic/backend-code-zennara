const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { protect } = require('../middleware/auth');
const {
  listMine, getMine, getMineHtml, getMinePdf, shareLink, sharedPdf,
} = require('../controllers/prescriptionController');

/*
 * The shared PDF link is public by design — Twilio fetches it for the
 * WhatsApp document and a guest may forward it — and its only protection is
 * the signed, expiring token in the URL. A token cannot be guessed (HMAC
 * over the note id), but the route should still not be free to hammer: this
 * caps one address at a modest rate so a scan of random tokens is throttled
 * long before it matters, while a guest opening their own link a few times
 * never notices.
 */
const sharedPdfLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  message: {
    success: false,
    message: 'Too many requests. Please try again in a few minutes.',
    code: 'RATE_LIMIT_EXCEEDED',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// PUBLIC (no session): the PDF behind a valid, unexpired share token — what
// WhatsApp delivers and what the app shares. Mounted before `protect`.
router.get('/shared/:token.pdf', sharedPdfLimiter, sharedPdf);

// The guest's own prescriptions, read-only. Doctors write them through
// /api/consultation-notes; nothing here can change one.
router.use(protect);
router.get('/', listMine);
router.get('/:id', getMine);
// The signed sheet as a page, in the dermatologist's chosen design — the
// panel's fallback view, kept for the app's in-page viewer.
router.get('/:id/html', getMineHtml);
// The same document as the PDF the guest received.
router.get('/:id/pdf', getMinePdf);
// A signed, 7-day link to that PDF for the app's share sheet.
router.get('/:id/share-link', shareLink);

module.exports = router;
