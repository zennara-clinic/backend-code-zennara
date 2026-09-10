const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/securitySettingsController');
const { protectAdmin, requireRole } = require('../../middleware/auth');

/*
 * Super admin only, and by role rather than by permission on purpose: these
 * switches govern who can get INTO the panels at all, so they must not be
 * grantable through a custom role that someone assembles later.
 */
router.use(protectAdmin, requireRole('super_admin'));

router.get('/', ctrl.get);
router.patch('/login-rate-limit', ctrl.setLoginRateLimit);
router.get('/locked-accounts', ctrl.lockedAccounts);
router.post('/unlock/:id', ctrl.unlockAccount);

module.exports = router;
