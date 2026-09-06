const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/providerBlockController');
const { protectAdmin, requirePermission, auditLog } = require('../middleware/auth');

router.use(protectAdmin);

// Any panel that paints a diary may read blocks (reception, dermatologist, therapist).
router.get('/', requirePermission('bookings.view', 'today.view', 'dermatologists.view'), ctrl.list);
router.post('/', requirePermission('bookings.manage'), auditLog('BOOKING_CREATED', 'BOOKING'), ctrl.create);
router.put('/:id', requirePermission('bookings.manage'), auditLog('BOOKING_UPDATED', 'BOOKING'), ctrl.update);
router.delete('/:id', requirePermission('bookings.manage'), auditLog('BOOKING_CANCELLED', 'BOOKING'), ctrl.remove);

module.exports = router;
