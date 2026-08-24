const express = require('express');
const router = express.Router();
const {
  getAuditLogs,
  getAuditFilters,
  createAuditLog,
  getSuspicious,
} = require('../../controllers/auditLogController');
const { protectAdmin, requireRole } = require('../../middleware/auth');
const READ = requireRole('super_admin');

router.use(protectAdmin);

// Static paths first so they are not read as an entry id.
router.get('/actions', READ, getAuditFilters);
router.get('/suspicious', READ, getSuspicious);

router.get('/', READ, getAuditLogs);
router.post('/', createAuditLog);

module.exports = router;
