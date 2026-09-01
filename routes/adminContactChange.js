const express = require('express');
const router = express.Router();
const { protectAdmin, requirePermission } = require('../middleware/auth');
const { adminList } = require('../controllers/contactChangeController');

// Staff visibility of customer contact-change requests (read-only; the changes
// apply automatically, this is for support + audit).
router.get('/', protectAdmin, requirePermission('contactChanges.view'), adminList);

module.exports = router;
