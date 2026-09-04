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

router.get('/', requirePermission('patientPhotos.view', 'patientPhotos.manage'), listPhotos);
router.post('/', requirePermission('patientPhotos.manage'), upload.array('photos', 10), uploadPhotos);
router.patch('/:id', requirePermission('patientPhotos.manage'), updatePhoto);
router.delete('/:id', requirePermission('patientPhotos.manage'), deletePhoto);

module.exports = router;
