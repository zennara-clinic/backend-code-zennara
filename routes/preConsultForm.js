const express = require('express');
const router = express.Router();
const {
  createOrUpdateForm,
  getUserForms,
  getFormById,
  deleteForm,
  submitForm,
  getAllForms,
  getAdminFormById,
  updateFormStatus
} = require('../controllers/preConsultFormController');
const { protect, protectAdmin } = require('../middleware/auth');

// Admin routes
router.get('/admin/all', protectAdmin, getAllForms);
// Must be declared BEFORE '/admin/:id', or Express matches "by-booking" as an id.
router.get(
  '/admin/by-booking/:bookingId',
  protectAdmin,
  require('../controllers/preConsultFormController').getFormStatusForBooking,
);
router.get('/admin/:id', protectAdmin, getAdminFormById);
router.patch('/admin/:id/status', protectAdmin, updateFormStatus);

// Protected user routes
router.use(protect);

router.post('/', createOrUpdateForm);
router.get('/', getUserForms);
router.get('/:id', getFormById);
router.delete('/:id', deleteForm);
router.patch('/:id/submit', submitForm);

module.exports = router;
