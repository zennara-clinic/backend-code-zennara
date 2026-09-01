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
  revealStaffPassword,
} = require('../../controllers/staffController');
const { protectAdmin, requirePermission, auditLog } = require('../../middleware/auth');

router.use(protectAdmin);

/*
 * These endpoints back two screens, not one. "Staff & roles" manages every
 * account and runs on the blanket `staff.*` permissions; the Therapists page
 * manages therapist rows only and runs on `therapists.*`. Each gate therefore
 * accepts either, and staffController narrows the caller to the roles their
 * permission actually covers (see `rolesInScope` there) — so a therapists-only
 * role can neither list nor touch a super admin through this route.
 */
const VIEW_STAFF = requirePermission('staff.view', 'therapists.view');
const MANAGE_STAFF = requirePermission('staff.manage', 'therapists.manage');
// Password set/reveal carries its own sensitive permission, so a role can
// manage accounts without ever seeing or changing credentials.
const MANAGE_PASSWORD = requirePermission('staff.password', 'therapists.password');

// The role-label helper is harmless metadata used across panels — keep it open
// to any signed-in staff. The staff LIST needs a view permission.
router.get('/roles', getRoles);
router.get('/', VIEW_STAFF, getStaff);

router.post('/', MANAGE_STAFF, auditLog('ADMIN_CREATED', 'ADMIN'), createStaff);
router.put('/:id', MANAGE_STAFF, updateStaff);
router.put('/:id/password', MANAGE_PASSWORD, auditLog('STAFF_UPDATED', 'ADMIN'), setStaffPassword);
// Reading a password is sensitive enough to audit like a change.
router.get('/:id/password', MANAGE_PASSWORD, auditLog('STAFF_UPDATED', 'ADMIN'), revealStaffPassword);
router.patch(
  '/:id/toggle-status',
  MANAGE_STAFF,
  auditLog('ADMIN_DEACTIVATED', 'ADMIN'),
  toggleStaffStatus,
);
router.delete('/:id', MANAGE_STAFF, auditLog('ADMIN_DEACTIVATED', 'ADMIN'), deleteStaff);

module.exports = router;
