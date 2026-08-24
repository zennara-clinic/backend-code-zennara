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
} = require('../../controllers/staffController');
const { protectAdmin, requireRole, auditLog } = require('../../middleware/auth');

router.use(protectAdmin);

// Any signed-in admin can see who is on the team and what the roles mean.
router.get('/roles', getRoles);
router.get('/', getStaff);

// Changing who can sign in is restricted to the top two roles.
//
// Every existing account in this clinic is role 'admin' — there is no
// super_admin — so gating on super_admin alone would lock staff management out
// entirely. The "you cannot remove the last active super admin" guard in the
// controller still applies once one exists.
const MANAGE_STAFF = requireRole('super_admin');

router.post('/', MANAGE_STAFF, auditLog('ADMIN_CREATED', 'ADMIN'), createStaff);
router.put('/:id', MANAGE_STAFF, updateStaff);
router.put('/:id/password', MANAGE_STAFF, auditLog('STAFF_UPDATED', 'ADMIN'), setStaffPassword);
router.patch(
  '/:id/toggle-status',
  MANAGE_STAFF,
  auditLog('ADMIN_DEACTIVATED', 'ADMIN'),
  toggleStaffStatus,
);
router.delete('/:id', MANAGE_STAFF, auditLog('ADMIN_DEACTIVATED', 'ADMIN'), deleteStaff);

module.exports = router;
