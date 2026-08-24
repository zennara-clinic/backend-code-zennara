const express = require('express');
const router = express.Router();
const {
  getTypes,
  getTree,
  createType,
  updateType,
  deleteType,
  syncCounts,
} = require('../controllers/serviceTypeController');
const { protectAdmin, auditLog, requireRole } = require('../middleware/auth');
const MANAGE = requireRole('super_admin');

// Public — the app browses the treatment menu by type before category.
router.get('/', getTypes);
router.get('/tree', getTree);

// Admin.
router.post('/', protectAdmin, MANAGE, auditLog('CATALOGUE_CREATED', 'CATALOGUE'), createType);
router.post('/sync-counts', protectAdmin, MANAGE, syncCounts);
router.put('/:id', protectAdmin, MANAGE, auditLog('CATALOGUE_UPDATED', 'CATALOGUE'), updateType);
router.delete('/:id', protectAdmin, MANAGE, auditLog('CATALOGUE_DELETED', 'CATALOGUE'), deleteType);

module.exports = router;
