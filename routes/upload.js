const express = require('express');
const router = express.Router();
const upload = require('../config/multer');
const {
  uploadMedia,
  deleteMedia,
  addMediaUrl
} = require('../controllers/uploadController');

// Upload media files (multiple)
router.post('/media', upload.array('media', 10), uploadMedia);

// Add media via URL
router.post('/media-url', addMediaUrl);

// Delete media
router.delete('/media/:publicId', deleteMedia);

module.exports = router;
