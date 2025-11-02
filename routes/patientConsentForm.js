const express = require('express');
const router = express.Router();
const {
  createConsentForm,
  getUserConsentForms,
  getConsentFormById,
  updateConsentForm,
  addDoctorSignature,
  getAllConsentForms,
  updateConsentFormStatus
} = require('../controllers/patientConsentFormController');
const { protect, protectAdmin } = require('../middleware/auth');

// Admin routes
router.get('/admin/all', protectAdmin, getAllConsentForms);
router.patch('/admin/:id/status', protectAdmin, updateConsentFormStatus);
router.patch('/admin/:id/doctor-sign', protectAdmin, addDoctorSignature);

// Protected user routes
router.use(protect);

router.post('/', createConsentForm);
router.get('/', getUserConsentForms);
router.get('/:id', getConsentFormById);
router.put('/:id', updateConsentForm);

module.exports = router;
