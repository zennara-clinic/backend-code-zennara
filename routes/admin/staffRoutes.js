const express = require('express');
const router = express.Router();
const {
  getStaff,
  createStaff,
  updateStaff,
  toggleStaffStatus,
  deleteStaff,
  getRoles,
  setStaffPassword,
  sendStaffCredentials,
  cloneStaff,
  terminateStaff,
} = require('../../controllers/staffController');
const { protectAdmin, requirePermission, auditLog } = require('../../middleware/auth');

router.use(protectAdmin);

/*
 * These endpoints back three screens, not one. "Staff & roles" manages every
 * account and runs on the blanket `staff.*` permissions; the Therapists and
 * Dermatologists pages manage one role each and run on `therapists.*` /
 * `dermatologists.*`. Each gate therefore accepts any of them, and
 * staffController narrows the caller to the roles their permission actually
 * covers (see `rolesInScope` there) — so a therapists-only role can neither
 * list nor touch a super admin through this route.
 */
const VIEW_STAFF = requirePermission(
  'staff.view', 'therapists.view', 'dermatologists.view',
  // Screens that must name clinical staff to assign work — see `rolesInScope`
  // in staffController, which narrows these callers to doctor/therapist rows.
  'bookings.view', 'bookings.manage', 'chat.view', 'chat.manage', 'today.view', 'overview.view',
);
const MANAGE_STAFF = requirePermission('staff.manage', 'therapists.manage', 'dermatologists.manage');

// The role-label helper is harmless metadata used across panels — keep it open
// to any signed-in staff. The staff LIST needs a view permission.
router.get('/roles', getRoles);
router.get('/', VIEW_STAFF, getStaff);

router.post('/', MANAGE_STAFF, auditLog('ADMIN_CREATED', 'ADMIN'), createStaff);
router.put('/:id', MANAGE_STAFF, updateStaff);
router.patch(
  '/:id/toggle-status',
  MANAGE_STAFF,
  auditLog('ADMIN_DEACTIVATED', 'ADMIN'),
  toggleStaffStatus,
);
router.delete('/:id', MANAGE_STAFF, auditLog('ADMIN_DEACTIVATED', 'ADMIN'), deleteStaff);

// Zenoti's Edit Employee actions: Update Password, Reset Password (send
// credentials), Clone, Terminate. Passwords are stored as a hash only.
router.put('/:id/password', MANAGE_STAFF, setStaffPassword);
router.post('/:id/send-credentials', MANAGE_STAFF, sendStaffCredentials);
router.post('/:id/clone', MANAGE_STAFF, auditLog('ADMIN_CREATED', 'ADMIN'), cloneStaff);
router.post('/:id/terminate', MANAGE_STAFF, terminateStaff);

module.exports = router;
