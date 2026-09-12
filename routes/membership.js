const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/membershipController');
const { protectAdmin, protect, requirePermission } = require('../middleware/auth');

// App: the signed-in guest's own membership (before the admin gate).
router.get('/me', protect, ctrl.me);
// App: the Zen membership on sale — price, copy, benefits (one figure, the one Razorpay charges).
router.get('/zen', protect, ctrl.zen);

router.use(protectAdmin);
const VIEW = requirePermission('memberships.view', 'memberships.manage', 'packages.view', 'patients.view');
const MANAGE = requirePermission('memberships.manage', 'packages.manage');

router.get('/', VIEW, ctrl.list);
router.post('/', MANAGE, ctrl.create);
// A dermatologist reads the memberships of their own guests only.
const scope = require('../utils/doctorGuestScope');

router.get('/members', VIEW, scope.scopedList({ bookingKey: null }), ctrl.listMembers);
router.post('/members', MANAGE, ctrl.sell);
router.get('/members/:id', VIEW, scope.ownRecord(require('../models/MembershipAssignment')), ctrl.getMember);
router.put('/members/:id', MANAGE, ctrl.updateMember);
router.post('/members/:id/cancel', MANAGE, ctrl.cancelMember);
router.post('/members/:id/zenoti-push', MANAGE, ctrl.zenotiPush);
router.get('/current/:userId', VIEW, scope.ownGuest((req) => req.params.userId), ctrl.currentForUser);
router.get('/:id', VIEW, ctrl.get);
router.put('/:id', MANAGE, ctrl.update);
router.patch('/:id/toggle', MANAGE, ctrl.toggle);

module.exports = router;
