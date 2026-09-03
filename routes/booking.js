const express = require('express');
const bookingController = require('../controllers/bookingController');
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
  cancelBookingAdmin,
  createBookingAdmin,
  rescheduleBookingAdmin,
  getVisitCode,
  verifyCheckInCode,
  verifyCheckOutCode,
  rejectReschedule
} = require('../controllers/bookingController');
const { protect, protectAdmin, auditLog, requirePermission } = require('../middleware/auth');
const { manualCleanup } = require('../utils/bookingScheduler');

// Public routes
router.get('/available-slots', getAvailableTimeSlots);

// Admin routes
/*
 * Reads are gated on `bookings.view` so a role that cannot open the Bookings
 * page cannot fetch the day book by URL either. Dermatologists and therapists
 * hold it through their role baseline (config/permissions.js).
 */
const VIEW = requirePermission('bookings.view', 'today.view', 'patients.view');
router.get('/admin/all', protectAdmin, VIEW, getAllBookingsAdmin);
router.get('/admin/export', protectAdmin, VIEW, bookingController.exportBookingsAdmin);
// Reception creates walk-in and phone bookings here.
router.post('/admin', protectAdmin, auditLog('BOOKING_CREATED', 'BOOKING'), createBookingAdmin);
router.get('/admin/:id', protectAdmin, VIEW, getBookingByIdAdmin);
router.put('/admin/:id/confirm', protectAdmin, auditLog('BOOKING_CONFIRMED', 'BOOKING'), confirmBooking);
router.put('/admin/:id/checkin', protectAdmin, auditLog('BOOKING_CHECKED_IN', 'BOOKING'), checkInBookingAdmin);
router.put('/admin/:id/checkout', protectAdmin, auditLog('BOOKING_CHECKED_OUT', 'BOOKING'), checkOutBookingAdmin);
// OTP-gated check-in/out: staff enter the code the guest reads to them.
router.post('/admin/:id/visit-code', protectAdmin, auditLog('BOOKING_UPDATED', 'BOOKING'), bookingController.sendVisitCodeAdmin);
router.get('/admin/:id/visit-code', protectAdmin, requirePermission('bookings.manage'), auditLog('BOOKING_UPDATED', 'BOOKING'), bookingController.revealVisitCodeAdmin);
router.put('/admin/:id/dermatologist', protectAdmin, auditLog('BOOKING_UPDATED', 'BOOKING'), bookingController.setDermatologistAdmin);
router.put('/admin/:id/therapist', protectAdmin, auditLog('BOOKING_UPDATED', 'BOOKING'), bookingController.setTherapistAdmin);
router.put('/admin/:id/verify-checkin', protectAdmin, auditLog('BOOKING_CHECKED_IN', 'BOOKING'), verifyCheckInCode);
router.put('/admin/:id/verify-checkout', protectAdmin, auditLog('BOOKING_CHECKED_OUT', 'BOOKING'), verifyCheckOutCode);
router.put('/admin/:id/no-show', protectAdmin, auditLog('BOOKING_NO_SHOW', 'BOOKING'), markNoShow);
router.put('/admin/:id/cancel', protectAdmin, auditLog('BOOKING_CANCELLED', 'BOOKING'), cancelBookingAdmin);
router.put('/admin/:id/payment', protectAdmin, auditLog('BOOKING_UPDATED', 'BOOKING'), bookingController.updateBookingPaymentAdmin);
router.put('/admin/:id/notes', protectAdmin, auditLog('BOOKING_UPDATED', 'BOOKING'), bookingController.addBookingNoteAdmin);
router.post('/admin/:id/zenoti-refresh', protectAdmin, VIEW, bookingController.refreshFromZenotiAdmin);
router.put('/admin/:id/reschedule', protectAdmin, auditLog('BOOKING_RESCHEDULED', 'BOOKING'), rescheduleBookingAdmin);
// Clinic declines a guest's reschedule request → reverts to the original slot.
router.put('/admin/:id/reject-reschedule', protectAdmin, auditLog('BOOKING_RESCHEDULED', 'BOOKING'), rejectReschedule);

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
router.get('/:id/visit-code', getVisitCode);
router.put('/:id/cancel', cancelBooking);
router.put('/:id/reschedule', rescheduleBooking);
router.put('/:id/checkin', checkInBooking);
router.put('/:id/checkout', checkOutBooking);
router.put('/:id/rate', rateBooking);

module.exports = router;
