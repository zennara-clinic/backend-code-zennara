const express = require('express');
const router = express.Router();
const {
  createOrUpdateForm,
  getUserForms,
  getMyFormStatus,
  getFormById,
  deleteForm,
  submitForm,
  getAllForms,
  getAdminFormById,
  updateFormStatus,
  getIntakeForUser,
  getSchema,
  digitiseForUser
} = require('../controllers/preConsultFormController');
const { protect, protectAdmin, requirePermission } = require('../middleware/auth');

// Admin routes. A dermatologist reads the forms of their own guests only.
const scope = require('../utils/doctorGuestScope');
// Reads only userId/bookingId, which are not encrypted, so a lean read is safe here.
const OWN_FORM = scope.ownRecord(require('../models/PreConsultForm'));

router.get('/admin/all', protectAdmin, scope.scopedList(), getAllForms);
// Must be declared BEFORE '/admin/:id', or Express matches "by-booking" as an id.
router.get(
  '/admin/by-booking/:bookingId',
  protectAdmin,
  scope.ownBooking((req) => req.params.bookingId),
  require('../controllers/preConsultFormController').getFormStatusForBooking,
);
/*
 * Intake state and digitising a paper form — also BEFORE '/admin/:id'.
 *
 * Typing up a guest's paper sheet is an edit of their record, so it takes
 * the same key as editing the record (patients.manage) or the forms area
 * (forms.view). A dermatologist holds both in their baseline and, as with
 * every guest read, only for guests in their own diary.
 */
router.get('/admin/schema', protectAdmin, getSchema);
router.get('/admin/intake/:userId', protectAdmin, scope.ownGuest((req) => req.params.userId), getIntakeForUser);
router.post(
  '/admin/digitise/:userId',
  protectAdmin,
  requirePermission('patients.manage', 'forms.view'),
  scope.ownGuest((req) => req.params.userId),
  digitiseForUser,
);
router.get('/admin/:id', protectAdmin, OWN_FORM, getAdminFormById);
router.patch('/admin/:id/status', protectAdmin, OWN_FORM, updateFormStatus);

// Protected user routes
router.use(protect);

// Photographs the patient attaches to the form. Six is plenty for a
// dermatology complaint and keeps a mis-tap from uploading a whole album.
router.post(
  '/photos',
  require('../config/multer').array('photos', 6),
  require('../controllers/preConsultFormController').uploadFormPhotos,
);
router.post('/', createOrUpdateForm);
router.get('/status', getMyFormStatus);
router.get('/', getUserForms);
router.get('/:id', getFormById);
router.delete('/:id', deleteForm);
router.patch('/:id/submit', submitForm);

module.exports = router;
