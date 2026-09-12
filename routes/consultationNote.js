const express = require('express');
const router = express.Router();
const {
  getNotes,
  getNoteForBooking,
  saveNote,
  deleteNote,
  renderPrescription,
  renderPrescriptionPdf,
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
// Signing (status:'Completed') delivers the PDF to the guest by email and
// WhatsApp from inside saveNote. There is deliberately NO send/resend route:
// the clinic's rule since 2026-09-12 is that a signature is the only send.
router.post('/', scope.ownBooking((req) => req.body?.bookingId), auditLog('PRESCRIPTION_SAVED', 'CLINICAL'), saveNote);
// The printable sheet in one of the branded designs (?template= previews an
// option before it is saved; ?draft=1 forces the preview ribbon). The .html
// page is the panel's fallback; the .pdf is the document the guest receives.
router.get('/:id/prescription.html', OWN_NOTE, renderPrescription);
router.get('/:id/prescription.pdf', OWN_NOTE, renderPrescriptionPdf);
router.delete('/:id', requirePermission('consultationNotes.manage'), OWN_NOTE, deleteNote);

module.exports = router;
