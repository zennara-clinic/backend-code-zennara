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

// The role-label helper is harmless metadata used across panels — keep it open
// to any signed-in staff. The staff LIST needs the view permission.
router.get('/roles', getRoles);
router.get('/', requirePermission('staff.view'), getStaff);

// Creating / editing staff and their sign-in requires the manage permission;
// super admins pass automatically. Password set/reveal carries its own
// sensitive permission so a role can manage staff without touching credentials.
const MANAGE_STAFF = requirePermission('staff.manage');
const MANAGE_PASSWORD = requirePermission('staff.password');

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
