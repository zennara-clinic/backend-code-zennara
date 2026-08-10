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
const { protectAdmin, requireRole } = require('../middleware/auth');

router.use(protectAdmin);

// A doctor's own view of what they charge, plus any open request.
router.get('/my-fee', getMyFee);

router.get('/', getRequests);
// Doctors raise these; the controller stops a doctor requesting for anyone else.
router.post('/', createRequest);
router.patch('/:id/withdraw', withdrawRequest);

// Deciding a request is an admin action — a doctor cannot approve their own.
router.patch('/:id/approve', requireRole('super_admin', 'admin'), approveRequest);
router.patch('/:id/reject', requireRole('super_admin', 'admin'), rejectRequest);
router.delete('/override/:doctorId', requireRole('super_admin', 'admin'), clearOverride);

module.exports = router;
