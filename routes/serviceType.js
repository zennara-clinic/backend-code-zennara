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
const { protectAdmin, auditLog } = require('../middleware/auth');

// Public — the app browses the treatment menu by type before category.
router.get('/', getTypes);
router.get('/tree', getTree);

// Admin.
router.post('/', protectAdmin, auditLog('CATALOGUE_CREATED', 'CATALOGUE'), createType);
router.post('/sync-counts', protectAdmin, syncCounts);
router.put('/:id', protectAdmin, auditLog('CATALOGUE_UPDATED', 'CATALOGUE'), updateType);
router.delete('/:id', protectAdmin, auditLog('CATALOGUE_DELETED', 'CATALOGUE'), deleteType);

module.exports = router;
