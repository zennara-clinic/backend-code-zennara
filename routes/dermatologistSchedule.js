const express = require('express');
const router = express.Router();
const {
  getSchedule,
  updateSchedule,
  getDefaultWeek,
  getAvailability,
  getSlots,
  getAnyAvailability,
  getAnySlots,
  getFreeDermatologists,
} = require('../controllers/dermatologistScheduleController');
const { protectAdmin, auditLog } = require('../middleware/auth');

/*
 * "Any available dermatologist" — declared first so the literal "any" is never
 * matched as a :doctorId slug.
 */
router.get('/any/availability', getAnyAvailability);
router.get('/any/slots', getAnySlots);
router.get('/any/free', getFreeDermatologists);

/*
 * Public — the app needs slots before anyone signs in, so it can show a
 * dermatologist's diary while the patient is still deciding. Only derived
 * availability is exposed; the underlying pattern is not.
 */
router.get('/:doctorId/availability', getAvailability);
router.get('/:doctorId/slots', getSlots);

/*
 * Panel — reading the pattern needs a login, and writing is narrowed further
 * inside the controller: admins may edit anyone, a dermatologist only
 * themselves. `requireRole` cannot express that, since it cannot see which
 * dermatologist the row belongs to.
 */
router.get('/:doctorId/schedule', protectAdmin, getSchedule);
router.get('/:doctorId/schedule/default', protectAdmin, getDefaultWeek);
router.put(
  '/:doctorId/schedule',
  protectAdmin,
  auditLog('DOCTOR_UPDATED', 'DOCTOR'),
  updateSchedule,
);

module.exports = router;
