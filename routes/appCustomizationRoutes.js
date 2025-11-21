const express = require('express');
const router = express.Router();
const {
  getCustomizationSettings,
  getAdminCustomizationSettings,
  updateCustomizationSettings,
  uploadCustomizationImage,
  resetCustomizationSettings
} = require('../controllers/appCustomizationController');
const { protectAdmin } = require('../middleware/auth');
const upload = require('../config/multer');

// Public route for mobile app
router.get('/', getCustomizationSettings);

// Admin routes
router.get('/admin', protectAdmin, getAdminCustomizationSettings);
router.put('/admin', protectAdmin, updateCustomizationSettings);
router.post('/admin/upload/:imageType', protectAdmin, upload.single('image'), uploadCustomizationImage);
router.post('/admin/reset', protectAdmin, resetCustomizationSettings);

module.exports = router;
