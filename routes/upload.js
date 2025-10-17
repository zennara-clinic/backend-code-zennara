const express = require('express');
const router = express.Router();
const upload = require('../config/multer');
const { protectAdmin } = require('../middleware/auth');
const {
  uploadMedia,
  deleteMedia,
  addMediaUrl,
  getAllMedia,
  getStorageStats
} = require('../controllers/uploadController');

// Get all media
router.get('/media/all', protectAdmin, getAllMedia);

// Get storage stats
router.get('/stats', protectAdmin, getStorageStats);

// Upload media files (multiple)
router.post('/media', protectAdmin, upload.array('media', 10), uploadMedia);

// Add media via URL
router.post('/media-url', protectAdmin, addMediaUrl);

// Delete media
router.delete('/media/:publicId', protectAdmin, deleteMedia);

module.exports = router;
