const express = require('express');
const router = express.Router();
const { protectAdmin, requireRole } = require('../middleware/auth');
const MANAGE = requireRole('super_admin');
const { adminList } = require('../controllers/contactChangeController');

// Staff visibility of customer contact-change requests (read-only; the changes
// apply automatically, this is for support + audit).
router.get('/', protectAdmin, adminList);

module.exports = router;
