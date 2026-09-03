const express = require('express');
const router = express.Router();
const { protectAdmin, requireRole, requirePermission } = require('../middleware/auth');
const { adminGuestOverview } = require('../controllers/zenotiController');
const z = require('../controllers/zenotiAdminController');

// Staff-only view of customers' Zenoti data for the unified panel (Panels/).
// This is the authorised way for clinic staff to inspect a customer's records —
// no customer-app impersonation, no OTP handling.
router.use(protectAdmin);

// Clinic (CRM) data is a module of its own — reading it needs `zenoti.view`.
const VIEW = requirePermission('zenoti.view', 'patients.view');
router.get('/overview', VIEW, adminGuestOverview); // legacy by-phone/email lookup
router.get('/status', VIEW, z.getStatus);
router.post('/import', requirePermission('zenoti.manage'), z.startImport);
router.post('/crawl', requirePermission('zenoti.manage'), z.startCrawl);
router.post('/appointments/sync', requirePermission('zenoti.manage'), z.syncAppointments);
router.post('/write-breaker/reset', requirePermission('zenoti.manage'), z.resetWriteBreaker);
router.post('/publish-doctor-hours', requirePermission('zenoti.manage'), z.publishDoctorHours);
router.get('/catalog/services', requirePermission('zenoti.view', 'services.view', 'packages.view'), z.listCatalogServices);
router.get('/catalog/packages', requirePermission('zenoti.view', 'services.view', 'packages.view'), z.listCatalogPackages);
router.get('/readiness', VIEW, z.getReadiness);
router.get('/practitioners', requirePermission('zenoti.view', 'patients.view', 'bookings.view'), z.listPractitioners);
router.post('/practitioners/sync', requirePermission('zenoti.manage'), z.syncPractitioners);
router.post('/practitioners/:employeeId/onboard', requirePermission('dermatologists.manage'), z.onboardPractitioner);

router.get('/packages', VIEW, z.listPackages);
router.get('/appointments', VIEW, z.listAppointments);
router.get('/memberships', VIEW, z.listMemberships);
router.get('/orders', VIEW, z.listOrders);
router.get('/notes', VIEW, z.listNotes);
router.get('/forms', VIEW, z.listForms);

router.get('/users/:userId', VIEW, z.getUserData);
router.post('/users/:userId/sync', VIEW, z.syncUser);

module.exports = router;
