const express = require('express');
const router = express.Router();
const { protectAdmin, requirePermission, auditLog } = require('../middleware/auth');
const po = require('../controllers/purchaseOrderController');

/**
 * Purchase orders. Procurement only — a dermatologist account holds none of
 * these permissions and cannot reach any of it.
 *
 * Approving is its own permission so the person who raises an order is not
 * necessarily the person who authorises the spend.
 */
router.use(protectAdmin);

const VIEW = requirePermission('purchaseOrders.view', 'purchaseOrders.manage');
const MANAGE = requirePermission('purchaseOrders.manage');

router.get('/', VIEW, po.listOrders);
router.get('/history/product/:productId', VIEW, po.productHistory);
router.get('/history/vendor/:vendorId', VIEW, po.vendorHistory);
router.get('/:id', VIEW, po.getOrder);

router.post('/', MANAGE, auditLog('PURCHASE_ORDER_CREATED', 'INVENTORY'), po.createOrder);
router.put('/:id', MANAGE, auditLog('PURCHASE_ORDER_UPDATED', 'INVENTORY'), po.updateOrder);

// Approving is separately permissioned; the controller still enforces the
// legal transitions, so this only decides who may attempt them.
router.patch(
  '/:id/status',
  requirePermission('purchaseOrders.manage', 'purchaseOrders.approve'),
  auditLog('PURCHASE_ORDER_STATUS_CHANGED', 'INVENTORY'),
  po.setStatus,
);

// Receiving raises stock, so it carries its own permission — a storekeeper may
// book a delivery in without being able to raise or approve an order.
router.post(
  '/:id/receive',
  requirePermission('inventory.receive', 'purchaseOrders.manage'),
  auditLog('GOODS_RECEIVED', 'INVENTORY'),
  po.receiveGoods,
);

module.exports = router;
