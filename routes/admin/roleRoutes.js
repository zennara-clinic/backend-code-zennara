const express = require('express');
const router = express.Router();
const { getCatalog, getRoles, createRole, updateRole, deleteRole } = require('../../controllers/roleController');
const { protectAdmin, requirePermission, auditLog } = require('../../middleware/auth');

router.use(protectAdmin);

/*
 * Reading roles is not only the Roles tab: the Staff tab renders each account's
 * role chip and its permission matrix, so anyone who may see or edit staff must
 * be able to read the role list and the catalog. Changing a role still needs
 * `roles.manage`. super_admin passes everything.
 */
const VIEW = requirePermission('roles.view', 'staff.view', 'staff.manage');
const MANAGE = requirePermission('roles.manage');

router.get('/catalog', VIEW, getCatalog);
router.get('/', VIEW, getRoles);
router.post('/', MANAGE, auditLog('ROLE_CREATED', 'ADMIN'), createRole);
router.put('/:id', MANAGE, auditLog('ROLE_UPDATED', 'ADMIN'), updateRole);
router.delete('/:id', MANAGE, auditLog('ROLE_DELETED', 'ADMIN'), deleteRole);

module.exports = router;
