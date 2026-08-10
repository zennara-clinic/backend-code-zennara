const express = require('express');
const router = express.Router();
const {
  getNotes,
  getNoteForBooking,
  saveNote,
  deleteNote,
} = require('../controllers/consultationNoteController');
const { protectAdmin, requireRole, auditLog } = require('../middleware/auth');

// Clinical records are staff-only.
router.use(protectAdmin);

router.get('/', getNotes);
router.get('/booking/:bookingId', getNoteForBooking);
router.post('/', auditLog('PRESCRIPTION_SAVED', 'CLINICAL'), saveNote);
router.delete('/:id', requireRole('super_admin', 'admin'), deleteNote);

module.exports = router;
