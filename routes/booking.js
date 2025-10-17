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
  getAvailableTimeSlots,
  getAllBookingsAdmin,
  confirmBooking,
  markNoShow,
  getBookingByIdAdmin,
  checkInBookingAdmin,
  checkOutBookingAdmin,
  cancelBookingAdmin
} = require('../controllers/bookingController');
const { protect, protectAdmin } = require('../middleware/auth');
const { manualCleanup } = require('../utils/bookingScheduler');

// Public routes
router.get('/available-slots', getAvailableTimeSlots);

// Admin routes
router.get('/admin/all', protectAdmin, getAllBookingsAdmin);
router.get('/admin/:id', protectAdmin, getBookingByIdAdmin);
router.put('/admin/:id/confirm', protectAdmin, confirmBooking);
router.put('/admin/:id/checkin', protectAdmin, checkInBookingAdmin);
router.put('/admin/:id/checkout', protectAdmin, checkOutBookingAdmin);
router.put('/admin/:id/no-show', protectAdmin, markNoShow);
router.put('/admin/:id/cancel', protectAdmin, cancelBookingAdmin);

// Manual cleanup endpoint for testing
router.post('/admin/cleanup-expired', protectAdmin, async (req, res) => {
  try {
    await manualCleanup();
    res.status(200).json({
      success: true,
      message: 'Manual cleanup executed successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to execute manual cleanup'
    });
  }
});

// Protected user routes
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
