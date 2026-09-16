const express = require('express');
const router = express.Router();
const upload = require('../config/multer');
const { protectAdmin, requireRole, requirePermission } = require('../middleware/auth');
const MANAGE = requirePermission('appStudio.manage');
const {
  uploadMedia,
  deleteMedia,
  addMediaUrl,
  getAllMedia,
  getStorageStats
} = require('../controllers/uploadController');

// Get all media
router.get('/media/all', protectAdmin, MANAGE, getAllMedia);

// Get storage stats
router.get('/stats', protectAdmin, MANAGE, getStorageStats);

// Upload media files (multiple). Multer's own failures (a file type it does
// not accept, a file over the size limit) come back as a 400 with the reason,
// not the generic 500 the app-wide handler would give.
router.post('/media', protectAdmin, (req, res, next) => {
  upload.array('media', 10)(req, res, (err) => {
    if (!err) return next();
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'That file is over the 50 MB limit' : err.message || 'Upload failed';
    return res.status(400).json({ success: false, message });
  });
}, uploadMedia);

// Add media via URL
router.post('/media-url', protectAdmin, addMediaUrl);

// Delete media
router.delete('/media/:publicId', protectAdmin, MANAGE, deleteMedia);

module.exports = router;
