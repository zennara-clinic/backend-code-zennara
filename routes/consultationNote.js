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
// Prescriptions and consult notes are clinical records — reading them needs the
// permission, which dermatologists hold through their role baseline.
router.use(requirePermission('consultationNotes.view', 'consultationNotes.manage', 'patients.view'));

// A dermatologist reads and writes notes for their own guests; ?doctorId= is forced to theirs.
const scope = require('../utils/doctorGuestScope');
const OWN_NOTE = scope.ownRecord(require('../models/ConsultationNote'));

router.get('/', scope.scopedList({ doctorKey: 'doctorId' }), getNotes);
router.get('/booking/:bookingId', scope.ownBooking((req) => req.params.bookingId), getNoteForBooking);
router.post('/', scope.ownBooking((req) => req.body?.bookingId), auditLog('PRESCRIPTION_SAVED', 'CLINICAL'), saveNote);
router.post('/:id/send', OWN_NOTE, auditLog('PRESCRIPTION_SAVED', 'CLINICAL'), require('../controllers/consultationNoteController').sendPrescription);
router.delete('/:id', requirePermission('consultationNotes.manage'), OWN_NOTE, deleteNote);

module.exports = router;
