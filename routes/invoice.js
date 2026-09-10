const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/invoiceController');
const { protectAdmin, requirePermission, auditLog } = require('../middleware/auth');

router.use(protectAdmin);

/*
 * A dermatologist holds bookings.view/manage for their diary, which these gates
 * accept. They read one of their own guests' bills as history and never touch
 * billing (utils/doctorGuestScope).
 */
const scope = require('../utils/doctorGuestScope');
const Invoice = require('../models/Invoice');
const OWN_INVOICE = scope.ownRecord(Invoice, { bookingField: 'bookingIds' });

const VIEW = requirePermission('billing.view', 'billing.manage', 'bookings.view', 'today.view');
const MANAGE = [requirePermission('billing.manage', 'bookings.manage'), scope.notForDoctors];
const VOID = [requirePermission('billing.void'), scope.notForDoctors];

router.get('/meta', VIEW, ctrl.meta);
router.get('/lookup', VIEW, scope.notForDoctors, ctrl.lookup);
router.get('/', VIEW, scope.scopedList(), ctrl.list);
router.post('/', MANAGE, auditLog('INVOICE_CREATED', 'INVOICE'), ctrl.create);
router.get('/summary', VIEW, scope.notForDoctors, ctrl.summary);
router.get('/for-booking/:bookingId', VIEW, scope.ownBooking((req) => req.params.bookingId), ctrl.forBooking);
router.get('/:id', VIEW, OWN_INVOICE, ctrl.get);
router.post('/guest/:userId/hydrate', VIEW, scope.ownGuest((req) => req.params.userId), ctrl.hydrateGuest);
router.post('/:id/zenoti-refresh', VIEW, OWN_INVOICE, ctrl.refreshFromZenoti);
router.put('/:id', MANAGE, auditLog('INVOICE_UPDATED', 'INVOICE'), ctrl.update);
router.get('/:id/receipt', VIEW, OWN_INVOICE, ctrl.receipt);
router.get('/:id/packages', VIEW, OWN_INVOICE, ctrl.guestPackages);
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
