const express = require('express');
const router = express.Router();
const {
  getAuditLogs,
  getAuditFilters,
  createAuditLog,
  getSuspicious,
} = require('../../controllers/auditLogController');
const { protectAdmin } = require('../../middleware/auth');

router.use(protectAdmin);

// Static paths first so they are not read as an entry id.
router.get('/actions', getAuditFilters);
router.get('/suspicious', getSuspicious);

router.get('/', getAuditLogs);
router.post('/', createAuditLog);

module.exports = router;
