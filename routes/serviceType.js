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
const { protectAdmin, auditLog, requireRole, requirePermission } = require('../middleware/auth');
/*
  * Service types are level 1 of the category taxonomy and are edited inline on
  * the Categories page ("+ New type", reorder, sync counts), which is revealed
  * by `categories.manage`. They are also the top of the services tree, so
  * `services.manage` keeps working for the Services page.
  */
const MANAGE = requirePermission('services.manage', 'categories.manage');

// Public — the app browses the treatment menu by type before category.
router.get('/', getTypes);
router.get('/tree', getTree);

// Admin.
router.post('/', protectAdmin, MANAGE, auditLog('CATALOGUE_CREATED', 'CATALOGUE'), createType);
router.post('/sync-counts', protectAdmin, MANAGE, syncCounts);
router.put('/:id', protectAdmin, MANAGE, auditLog('CATALOGUE_UPDATED', 'CATALOGUE'), updateType);
router.delete('/:id', protectAdmin, MANAGE, auditLog('CATALOGUE_DELETED', 'CATALOGUE'), deleteType);

module.exports = router;
