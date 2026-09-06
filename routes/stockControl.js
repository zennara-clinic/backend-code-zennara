const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/stockControlController');
const { protectAdmin, requirePermission, auditLog } = require('../middleware/auth');

router.use(protectAdmin);
const VIEW = requirePermission('inventory.view', 'stockLedger.view');
const COUNT = requirePermission('inventory.count', 'inventory.manage');
const RECONCILE = requirePermission('inventory.reconcile');
const TRANSFER = requirePermission('inventory.transfer', 'inventory.manage');
const MANAGE = requirePermission('inventory.manage');

router.get('/current', VIEW, ctrl.currentStock);
router.get('/valuation', VIEW, ctrl.valuation);
router.post('/adjust', MANAGE, auditLog('INVENTORY_UPDATED', 'INVENTORY'), ctrl.adjust);

router.get('/counts', VIEW, ctrl.listCounts);
router.post('/counts', COUNT, auditLog('INVENTORY_UPDATED', 'INVENTORY'), ctrl.createCount);
router.get('/counts/:id', VIEW, ctrl.getCount);
router.put('/counts/:id', COUNT, ctrl.updateCount);
router.post('/counts/:id/submit', COUNT, auditLog('INVENTORY_UPDATED', 'INVENTORY'), ctrl.submitCount);
router.post('/counts/:id/reconcile', RECONCILE, auditLog('STOCK_UPDATED', 'INVENTORY'), ctrl.reconcileCount);
router.post('/counts/:id/cancel', COUNT, ctrl.cancelCount);

router.get('/transfers', VIEW, ctrl.listTransfers);
router.post('/transfers', TRANSFER, auditLog('STOCK_UPDATED', 'INVENTORY'), ctrl.createTransfer);
router.get('/transfers/:id', VIEW, ctrl.getTransfer);
router.post('/transfers/:id/send', TRANSFER, auditLog('STOCK_UPDATED', 'INVENTORY'), ctrl.sendTransfer);
router.post('/transfers/:id/receive', TRANSFER, auditLog('STOCK_UPDATED', 'INVENTORY'), ctrl.receiveTransfer);
router.post('/transfers/:id/cancel', TRANSFER, auditLog('STOCK_UPDATED', 'INVENTORY'), ctrl.cancelTransfer);

module.exports = router;
