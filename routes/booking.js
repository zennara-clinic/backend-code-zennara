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
  rejectReschedule
} = require('../controllers/bookingController');
const { protect, protectAdmin, auditLog, requirePermission } = require('../middleware/auth');
const { manualCleanup } = require('../utils/bookingScheduler');

// Public routes
router.get('/available-slots', getAvailableTimeSlots);
// What the signed-in guest may book today (new guests: a consultation first).
router.get('/eligibility', protect, require('../controllers/prescriptionController').eligibility);

// Admin routes
/*
 * Reads are gated on `bookings.view` so a role that cannot open the Bookings
 * page cannot fetch the day book by URL either. Dermatologists and therapists
 * hold it through their role baseline (config/permissions.js).
 */
const VIEW = requirePermission('bookings.view', 'today.view', 'patients.view');
/*
 * A dermatologist's list is already their own diary (bookingController
 * scopeToOwnDiary); naming a guest (?userId=) or opening an appointment by id
 * is allowed only for a guest in that diary (utils/doctorGuestScope).
 */
const scope = require('../utils/doctorGuestScope');
const OWN = scope.ownBooking((req) => req.params.id);
router.get('/admin/all', protectAdmin, VIEW, scope.ownGuestIfNamed('userId'), getAllBookingsAdmin);
router.get('/admin/export', protectAdmin, VIEW, scope.ownGuestIfNamed('userId'), bookingController.exportBookingsAdmin);
// Reception creates walk-in and phone bookings here.
router.post('/admin', protectAdmin, auditLog('BOOKING_CREATED', 'BOOKING'), createBookingAdmin);
router.get('/admin/:id', protectAdmin, VIEW, OWN, getBookingByIdAdmin);
router.put('/admin/:id/confirm', protectAdmin, OWN, auditLog('BOOKING_CONFIRMED', 'BOOKING'), confirmBooking);
/*
 * The desk's appointment lifecycle, in Zenoti's own shape: check in, undo
 * check-in, start, undo start, complete, reopen, no show, cancel and undos.
 * One endpoint takes the action name; the two legacy paths below stay so an
 * older panel build keeps working.
 */
router.get('/admin/:id/lifecycle', protectAdmin, VIEW, OWN, bookingController.getBookingLifecycleAdmin);
router.post('/admin/:id/lifecycle', protectAdmin, requirePermission('bookings.manage'), OWN, auditLog('BOOKING_UPDATED', 'BOOKING'), bookingController.bookingLifecycleAdmin);
router.put('/admin/:id/checkin', protectAdmin, OWN, auditLog('BOOKING_CHECKED_IN', 'BOOKING'), checkInBookingAdmin);
router.put('/admin/:id/checkout', protectAdmin, OWN, auditLog('BOOKING_CHECKED_OUT', 'BOOKING'), checkOutBookingAdmin);
router.put('/admin/:id/dermatologist', protectAdmin, OWN, auditLog('BOOKING_UPDATED', 'BOOKING'), bookingController.setDermatologistAdmin);
router.put('/admin/:id/therapist', protectAdmin, OWN, auditLog('BOOKING_UPDATED', 'BOOKING'), bookingController.setTherapistAdmin);
// Visit codes were retired on 2026-09-07 — Zenoti has no such concept and the
// desk now moves the appointment directly. Answer 410 rather than 404 so an
// un-updated panel tab tells its user why the button vanished.
const codesRetired = (_req, res) => res.status(410).json({
  success: false,
  code: 'VISIT_CODES_RETIRED',
  message: 'Visit codes are gone. Use Check in / Start session / Complete session on the appointment.',
});
router.post('/admin/:id/visit-code', protectAdmin, codesRetired);
router.get('/admin/:id/visit-code', protectAdmin, codesRetired);
router.put('/admin/:id/verify-checkin', protectAdmin, codesRetired);
router.put('/admin/:id/verify-checkout', protectAdmin, codesRetired);
router.put('/admin/:id/no-show', protectAdmin, OWN, auditLog('BOOKING_NO_SHOW', 'BOOKING'), markNoShow);
router.put('/admin/:id/cancel', protectAdmin, OWN, auditLog('BOOKING_CANCELLED', 'BOOKING'), cancelBookingAdmin);
router.put('/admin/:id/payment', protectAdmin, OWN, auditLog('BOOKING_UPDATED', 'BOOKING'), bookingController.updateBookingPaymentAdmin);
router.put('/admin/:id/notes', protectAdmin, OWN, auditLog('BOOKING_UPDATED', 'BOOKING'), bookingController.addBookingNoteAdmin);
// Step the last desk status change back (undo check-in / check-out / no-show / cancel).
router.post('/admin/:id/undo', protectAdmin, requirePermission('bookings.manage'), OWN, auditLog('BOOKING_UPDATED', 'BOOKING'), bookingController.undoBookingStatusAdmin);
// Clinical lifecycle (waiting → started → completed → prescribed → follow-up).
// Never touches `status`, so it cannot disturb the diary or the Zenoti mirror.
router.patch('/admin/:id/stage', protectAdmin, OWN, auditLog('BOOKING_UPDATED', 'BOOKING'), bookingController.updateConsultationStage);
router.post('/admin/:id/zenoti-refresh', protectAdmin, VIEW, OWN, bookingController.refreshFromZenotiAdmin);
router.post('/admin/:id/zenoti-push', protectAdmin, requirePermission('bookings.manage'), OWN, auditLog('BOOKING_UPDATED', 'BOOKING'), bookingController.pushToZenotiAdmin);
router.put('/admin/:id/reschedule', protectAdmin, OWN, auditLog('BOOKING_RESCHEDULED', 'BOOKING'), rescheduleBookingAdmin);
// Clinic declines a guest's reschedule request → reverts to the original slot.
router.put('/admin/:id/reject-reschedule', protectAdmin, OWN, auditLog('BOOKING_RESCHEDULED', 'BOOKING'), rejectReschedule);

// Manual cleanup endpoint for testing
router.post('/admin/cleanup-expired', protectAdmin, scope.notForDoctors, async (req, res) => {
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
// Retired with the visit codes (see above): the app shows the live status of
// the appointment instead of a code to read out.
router.get('/:id/visit-code', (_req, res) => res.status(410).json({
  success: false,
  code: 'VISIT_CODES_RETIRED',
  message: 'Check-in codes are no longer used — reception checks you in when you arrive.',
}));
router.put('/:id/cancel', cancelBooking);
router.put('/:id/reschedule', rescheduleBooking);
// Self check-in/out from the app is retired: attendance is recorded at the
// desk or arrives from Zenoti. Left open, a guest could mark any booking —
// including a clinic one — as attended from anywhere, and the diary merge
// would then keep that state.
const retired = (_req, res) => res.status(410).json({
  success: false,
  code: 'SELF_CHECKIN_RETIRED',
  message: 'Reception checks you in when you arrive at the clinic.',
});
router.put('/:id/checkin', retired);
router.put('/:id/checkout', retired);
router.put('/:id/rate', rateBooking);

module.exports = router;
