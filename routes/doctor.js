const express = require('express');
const router = express.Router();
const {
  getAllDoctors,
  getDoctorById,
  getTiers,
  updateTier,
  createDoctor,
  updateDoctor,
  toggleDoctorStatus,
  deleteDoctor,
} = require('../controllers/doctorController');
const { protectAdmin, requireAccess, requirePermission, auditLog, identifyAdmin } = require('../middleware/auth');

// Public — the mobile app reads the team and the tier fees.
router.get('/', identifyAdmin, getAllDoctors);
router.get('/tiers/list', getTiers);
router.get('/me', protectAdmin, require('../controllers/doctorController').getMyDoctor);

// Admin — tier pricing. Declared before /:id so "tiers" is never read as an id.
router.put(
  '/tiers/:tierId',
  protectAdmin,
  requirePermission('dermatologists.manage'),
  auditLog('SETTINGS_UPDATED', 'SETTINGS'),
  updateTier,
);

// Admin — doctor CRUD.
router.post(
  '/',
  protectAdmin,
  requirePermission('dermatologists.manage'),
  auditLog('DOCTOR_CREATED', 'DOCTOR'),
  createDoctor,
);
router.put(
  '/:id',
  protectAdmin,
  // Doctors may edit their own profile; the controller enforces ownership
  // and strips fee/tier for them. Admin-panel staff need the manage permission.
  requireAccess({ permissions: 'dermatologists.manage', roles: 'doctor' }),
  auditLog('DOCTOR_UPDATED', 'DOCTOR'),
  updateDoctor,
);
router.patch(
  '/:id/toggle-status',
  protectAdmin,
  requirePermission('dermatologists.manage'),
  auditLog('DOCTOR_STATUS_CHANGED', 'DOCTOR'),
  toggleDoctorStatus,
);
router.delete(
  '/:id',
  protectAdmin,
  requirePermission('dermatologists.manage'),
  auditLog('DOCTOR_DELETED', 'DOCTOR'),
  deleteDoctor,
);

// Public single lookup — last so it does not shadow the routes above.
const dc = require('../controllers/doctorController');
router.get('/:id/stats', protectAdmin, dc.getDoctorStats);
router.get('/:id/account', protectAdmin, requirePermission('dermatologists.manage'), dc.getDoctorAccount);
router.put('/:id/account/password', protectAdmin, requirePermission('dermatologists.password'), auditLog('STAFF_UPDATED', 'ADMIN'), dc.setDoctorPassword);
// Reading a password is sensitive enough to audit like a change.
router.get('/:id/account/password', protectAdmin, requirePermission('dermatologists.password'), auditLog('STAFF_UPDATED', 'ADMIN'), dc.revealDoctorPassword);
router.get('/:id', identifyAdmin, getDoctorById);

module.exports = router;
