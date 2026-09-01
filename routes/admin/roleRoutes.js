const express = require('express');
const router = express.Router();
const { getCatalog, getRoles, createRole, updateRole, deleteRole } = require('../../controllers/roleController');
const { protectAdmin, requirePermission, auditLog } = require('../../middleware/auth');

router.use(protectAdmin);

// Reading the catalog and role list needs the view permission (super_admin passes).
const VIEW = requirePermission('roles.view');
const MANAGE = requirePermission('roles.manage');

router.get('/catalog', VIEW, getCatalog);
router.get('/', VIEW, getRoles);
router.post('/', MANAGE, auditLog('ROLE_CREATED', 'ADMIN'), createRole);
router.put('/:id', MANAGE, auditLog('ROLE_UPDATED', 'ADMIN'), updateRole);
router.delete('/:id', MANAGE, auditLog('ROLE_DELETED', 'ADMIN'), deleteRole);

module.exports = router;
