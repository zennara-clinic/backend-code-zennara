const express = require('express');
const router = express.Router();
const {
  createConsentForm,
  getUserConsentForms,
  getConsentFormById,
  updateConsentForm,
  addDoctorSignature,
  getAllConsentForms,
  getAdminConsentFormById,
  updateConsentFormStatus
} = require('../controllers/patientConsentFormController');
const { protect, protectAdmin } = require('../middleware/auth');

// Admin routes. A dermatologist reads and signs the forms of their own guests only.
const scope = require('../utils/doctorGuestScope');
const OWN_CONSENT = scope.ownRecord(require('../models/PatientConsentForm'));

router.get('/admin/all', protectAdmin, scope.scopedList(), getAllConsentForms);
router.get('/admin/:id', protectAdmin, OWN_CONSENT, getAdminConsentFormById);
router.patch('/admin/:id/status', protectAdmin, OWN_CONSENT, updateConsentFormStatus);
router.patch('/admin/:id/doctor-sign', protectAdmin, OWN_CONSENT, addDoctorSignature);

// Protected user routes
router.use(protect);

router.post('/', createConsentForm);
router.get('/', getUserConsentForms);
router.get('/:id', getConsentFormById);
router.put('/:id', updateConsentForm);

module.exports = router;
