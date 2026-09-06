const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/membershipController');
const { protectAdmin, requirePermission } = require('../middleware/auth');

router.use(protectAdmin);
const VIEW = requirePermission('memberships.view', 'memberships.manage', 'packages.view', 'patients.view');
const MANAGE = requirePermission('memberships.manage', 'packages.manage');

router.get('/', VIEW, ctrl.list);
router.post('/', MANAGE, ctrl.create);
router.get('/members', VIEW, ctrl.listMembers);
router.post('/members', MANAGE, ctrl.sell);
router.get('/members/:id', VIEW, ctrl.getMember);
router.put('/members/:id', MANAGE, ctrl.updateMember);
router.post('/members/:id/cancel', MANAGE, ctrl.cancelMember);
router.get('/current/:userId', VIEW, ctrl.currentForUser);
router.get('/:id', VIEW, ctrl.get);
router.put('/:id', MANAGE, ctrl.update);
router.patch('/:id/toggle', MANAGE, ctrl.toggle);

module.exports = router;
