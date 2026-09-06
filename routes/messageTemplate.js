const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/messageTemplateController');
const { protectAdmin, requirePermission } = require('../middleware/auth');

router.use(protectAdmin);
const VIEW = requirePermission('chat.view', 'chat.manage', 'bookings.view', 'templates.manage');
const MANAGE = requirePermission('templates.manage', 'chat.manage');
router.get('/', VIEW, ctrl.list);
router.post('/', MANAGE, ctrl.create);
router.put('/:id', MANAGE, ctrl.update);
router.delete('/:id', MANAGE, ctrl.remove);
router.post('/:id/preview', VIEW, ctrl.preview);
module.exports = router;
