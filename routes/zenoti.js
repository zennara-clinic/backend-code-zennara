const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const {
  getProfile,
  getAppointments,
  getOrders,
  getMemberships,
  getPackages,
  getOverview,
  sync,
  getWriteStatus,
  ensureGuest,
  resyncBooking,
  resyncOrder,
} = require('../controllers/zenotiController');

// All Zenoti data is per-customer and read from the CRM on demand. Every route
// is protected and scoped to the signed-in user's own linked guest record.
router.get('/profile', protect, getProfile);
router.get('/appointments', protect, getAppointments);
router.get('/orders', protect, getOrders);
router.get('/memberships', protect, getMemberships);
router.get('/packages', protect, getPackages);
router.get('/overview', protect, getOverview);
router.post('/sync', protect, sync);

// Write-back (Phase 2)
router.get('/write-status', protect, getWriteStatus);
router.post('/ensure-guest', protect, ensureGuest);
router.post('/bookings/:id/resync', protect, resyncBooking);
router.post('/orders/:id/resync', protect, resyncOrder);

module.exports = router;
