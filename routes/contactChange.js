const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const {
  start,
  verify,
  submit,
  getPending,
  cancel,
} = require('../controllers/contactChangeController');

// Self-service email/phone change for the signed-in customer. Every route is
// scoped to req.user — a customer can only change their own contact details.
router.post('/start', protect, start);
router.post('/verify', protect, verify);
router.post('/submit', protect, submit);
router.get('/pending', protect, getPending);
router.post('/:id/cancel', protect, cancel);

module.exports = router;
