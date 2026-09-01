const express = require('express');
const router = express.Router();
const {
  getNotes,
  getNoteForBooking,
  saveNote,
  deleteNote,
} = require('../controllers/consultationNoteController');
const { protectAdmin, requireRole, requirePermission, auditLog } = require('../middleware/auth');

// Clinical records are staff-only.
router.use(protectAdmin);

router.get('/', getNotes);
router.get('/booking/:bookingId', getNoteForBooking);
router.post('/', auditLog('PRESCRIPTION_SAVED', 'CLINICAL'), saveNote);
router.post('/:id/send', auditLog('PRESCRIPTION_SAVED', 'CLINICAL'), require('../controllers/consultationNoteController').sendPrescription);
router.delete('/:id', requirePermission('consultationNotes.manage'), deleteNote);

module.exports = router;
