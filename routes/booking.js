const express = require('express');
const router = express.Router();
const {
  createBooking,
  getUserBookings,
  getBooking,
  getBookingByReference,
  cancelBooking,
  rescheduleBooking,
  checkInBooking,
  checkOutBooking,
  rateBooking,
  getAvailableTimeSlots
} = require('../controllers/bookingController');
const { protect } = require('../middleware/auth');

// Public routes
router.get('/available-slots', getAvailableTimeSlots);

// Protected routes
router.use(protect);

router.post('/', createBooking);
router.get('/', getUserBookings);
router.get('/reference/:referenceNumber', getBookingByReference);
router.get('/:id', getBooking);
router.put('/:id/cancel', cancelBooking);
router.put('/:id/reschedule', rescheduleBooking);
router.put('/:id/checkin', checkInBooking);
router.put('/:id/checkout', checkOutBooking);
router.put('/:id/rate', rateBooking);

module.exports = router;
