const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/invoiceController');
const { protectAdmin, requirePermission, auditLog } = require('../middleware/auth');

router.use(protectAdmin);

const VIEW = requirePermission('billing.view', 'billing.manage', 'bookings.view', 'today.view');
const MANAGE = requirePermission('billing.manage', 'bookings.manage');
const VOID = requirePermission('billing.void');

router.get('/meta', VIEW, ctrl.meta);
router.get('/lookup', VIEW, ctrl.lookup);
router.get('/', VIEW, ctrl.list);
router.post('/', MANAGE, auditLog('INVOICE_CREATED', 'INVOICE'), ctrl.create);
router.get('/:id', VIEW, ctrl.get);
router.put('/:id', MANAGE, auditLog('INVOICE_UPDATED', 'INVOICE'), ctrl.update);
router.get('/:id/receipt', VIEW, ctrl.receipt);
router.get('/:id/packages', VIEW, ctrl.guestPackages);
router.post('/:id/send', MANAGE, ctrl.sendReceipt);
router.post('/:id/lines', MANAGE, auditLog('INVOICE_UPDATED', 'INVOICE'), ctrl.addLine);
router.put('/:id/lines/:lineId', MANAGE, auditLog('INVOICE_UPDATED', 'INVOICE'), ctrl.updateLine);
router.delete('/:id/lines/:lineId', MANAGE, auditLog('INVOICE_UPDATED', 'INVOICE'), ctrl.removeLine);
router.post('/:id/redeem', MANAGE, auditLog('INVOICE_UPDATED', 'INVOICE'), ctrl.applyPackage);
router.delete('/:id/redeem/:lineId', MANAGE, auditLog('INVOICE_UPDATED', 'INVOICE'), ctrl.removeRedemption);
router.post('/:id/redeem-membership', MANAGE, auditLog('INVOICE_UPDATED', 'INVOICE'), ctrl.applyMembershipCredits);
router.post('/:id/payments', MANAGE, auditLog('PAYMENT_RECORDED', 'INVOICE'), ctrl.addPayment);
router.delete('/:id/payments/:paymentId', VOID, auditLog('PAYMENT_VOIDED', 'INVOICE'), ctrl.voidPayment);
router.post('/:id/close', MANAGE, auditLog('INVOICE_CLOSED', 'INVOICE'), ctrl.close);
router.post('/:id/reopen', VOID, auditLog('INVOICE_REOPENED', 'INVOICE'), ctrl.reopen);
router.post('/:id/void', VOID, auditLog('INVOICE_VOIDED', 'INVOICE'), ctrl.void);

module.exports = router;
