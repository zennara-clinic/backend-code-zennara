const express = require('express');
const router = express.Router();
const {
  getRequests,
  getMyFee,
  createRequest,
  approveRequest,
  rejectRequest,
  withdrawRequest,
  clearOverride,
} = require('../controllers/doctorFeeRequestController');
const { protectAdmin, requirePermission } = require('../middleware/auth');

router.use(protectAdmin);

// A doctor's own view of what they charge, plus any open request.
router.get('/my-fee', getMyFee);

router.get('/', getRequests);
// Doctors raise these; the controller stops a doctor requesting for anyone else.
router.post('/', createRequest);
router.patch('/:id/withdraw', withdrawRequest);

// Deciding a request is an admin action — a doctor cannot approve their own.
// `dermatologists.manage` is deliberately absent from the doctor baseline, so
// this still cannot be self-approved by the dermatologist who raised it.
const DECIDE = requirePermission('dermatologists.manage');
router.patch('/:id/approve', DECIDE, approveRequest);
router.patch('/:id/reject', DECIDE, rejectRequest);
router.delete('/override/:doctorId', DECIDE, clearOverride);

module.exports = router;
