const express = require('express');
const router = express.Router();
const { protectAdmin, requireRole } = require('../middleware/auth');
const { adminGuestOverview } = require('../controllers/zenotiController');
const z = require('../controllers/zenotiAdminController');

// Staff-only view of customers' Zenoti data for the unified panel (Panels/).
// This is the authorised way for clinic staff to inspect a customer's records —
// no customer-app impersonation, no OTP handling.
router.use(protectAdmin);

router.get('/overview', adminGuestOverview); // legacy by-phone/email lookup
router.get('/status', z.getStatus);
router.post('/import', requireRole('admin'), z.startImport);
router.post('/crawl', requireRole('admin'), z.startCrawl);
router.post('/appointments/sync', requireRole('admin'), z.syncAppointments);
router.get('/practitioners', z.listPractitioners);
router.post('/practitioners/sync', requireRole('admin'), z.syncPractitioners);

router.get('/packages', z.listPackages);
router.get('/appointments', z.listAppointments);
router.get('/memberships', z.listMemberships);
router.get('/orders', z.listOrders);
router.get('/notes', z.listNotes);
router.get('/forms', z.listForms);

router.get('/users/:userId', z.getUserData);
router.post('/users/:userId/sync', z.syncUser);

module.exports = router;
