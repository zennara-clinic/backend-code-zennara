const express = require('express');
const router = express.Router();
const upload = require('../config/multer');
const { protectAdmin, requirePermission } = require('../middleware/auth');
const {
  uploadPhotos,
  listPhotos,
  updatePhoto,
  deletePhoto,
} = require('../controllers/patientPhotoController');

/**
 * Clinical photographs. Staff only — there is no patient-facing route here.
 *
 * Reading and capturing are separate permissions so a role can be given the
 * timeline (to compare progress) without being able to add to the record.
 */
router.use(protectAdmin);

// A dermatologist sees and adds photographs of their own guests only.
const scope = require('../utils/doctorGuestScope');
const OWN_PHOTO = scope.ownRecord(require('../models/PatientPhoto'));

router.get('/', requirePermission('patientPhotos.view', 'patientPhotos.manage'), scope.scopedList(), listPhotos);
// After multer: the guest id arrives in the multipart body.
router.post('/', requirePermission('patientPhotos.manage'), upload.array('photos', 10), scope.ownGuest((req) => req.body?.userId), uploadPhotos);
router.patch('/:id', requirePermission('patientPhotos.manage'), OWN_PHOTO, updatePhoto);
router.delete('/:id', requirePermission('patientPhotos.manage'), OWN_PHOTO, deletePhoto);

module.exports = router;
