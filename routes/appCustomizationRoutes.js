const express = require('express');
const router = express.Router();
const {
  getCustomizationSettings,
  getAdminCustomizationSettings,
  updateCustomizationSettings,
  uploadCustomizationImage,
  resetCustomizationSettings,
  addConsultationCard,
  updateConsultationCard,
  deleteConsultationCard,
  addReelVideo,
  deleteReelVideo
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

// Consultation category cards management
router.post('/admin/consultation-card', protectAdmin, upload.single('image'), addConsultationCard);
router.put('/admin/consultation-card/:cardId', protectAdmin, upload.single('image'), updateConsultationCard);
router.delete('/admin/consultation-card/:cardId', protectAdmin, deleteConsultationCard);

// Self-hosted reels for the home rail (video + optional poster image)
router.post(
  '/admin/reel-videos',
  protectAdmin,
  upload.fields([{ name: 'video', maxCount: 1 }, { name: 'poster', maxCount: 1 }]),
  addReelVideo
);
router.put('/admin/reel-videos/:reelId', protectAdmin, require('../controllers/appCustomizationController').updateReelVideo);
router.delete('/admin/reel-videos/:reelId', protectAdmin, deleteReelVideo);

module.exports = router;
