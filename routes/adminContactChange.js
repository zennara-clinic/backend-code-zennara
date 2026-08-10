const express = require('express');
const router = express.Router();
const { protectAdmin } = require('../middleware/auth');
const { adminList } = require('../controllers/contactChangeController');

// Staff visibility of customer contact-change requests (read-only; the changes
// apply automatically, this is for support + audit).
router.get('/', protectAdmin, adminList);

module.exports = router;
