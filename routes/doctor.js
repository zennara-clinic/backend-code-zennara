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
const { protectAdmin, requireRole, auditLog } = require('../middleware/auth');

// Public — the mobile app reads the team and the tier fees.
router.get('/', getAllDoctors);
router.get('/tiers/list', getTiers);

// Admin — tier pricing. Declared before /:id so "tiers" is never read as an id.
router.put(
  '/tiers/:tierId',
  protectAdmin,
  requireRole('super_admin', 'admin'),
  auditLog('SETTINGS_UPDATED', 'SETTINGS'),
  updateTier,
);

// Admin — doctor CRUD.
router.post(
  '/',
  protectAdmin,
  requireRole('super_admin', 'admin'),
  auditLog('DOCTOR_CREATED', 'DOCTOR'),
  createDoctor,
);
router.put(
  '/:id',
  protectAdmin,
  requireRole('super_admin', 'admin'),
  auditLog('DOCTOR_UPDATED', 'DOCTOR'),
  updateDoctor,
);
router.patch(
  '/:id/toggle-status',
  protectAdmin,
  requireRole('super_admin', 'admin'),
  auditLog('DOCTOR_STATUS_CHANGED', 'DOCTOR'),
  toggleDoctorStatus,
);
router.delete(
  '/:id',
  protectAdmin,
  requireRole('super_admin', 'admin'),
  auditLog('DOCTOR_DELETED', 'DOCTOR'),
  deleteDoctor,
);

// Public single lookup — last so it does not shadow the routes above.
router.get('/:id', getDoctorById);

module.exports = router;
