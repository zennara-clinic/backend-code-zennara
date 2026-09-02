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
const { protectAdmin, requireRole, requirePermission } = require('../middleware/auth');
const MANAGE = requirePermission('appStudio.manage');
/*
 * The Terms & privacy, membership card, consultation page and screen-copy
 * editors all save through this one endpoint, but they are revealed by
 * `appContent.manage` rather than `appStudio.manage`. Accept either here and
 * let the controller restrict a content-only caller to the content fields, so
 * the narrower permission cannot reach the app's appearance or home layout.
 */
const MANAGE_OR_CONTENT = requirePermission('appStudio.manage', 'appContent.manage');
const upload = require('../config/multer');

// Public route for mobile app
router.get('/', getCustomizationSettings);

// Admin routes
// Reading what the app currently shows: any screen that renders it, including
// the clinical panels' patient view and the Terms & privacy editor.
router.get('/admin', protectAdmin, requirePermission('appStudio.view', 'appContent.manage', 'patients.view'), getAdminCustomizationSettings);
router.put('/admin', protectAdmin, MANAGE_OR_CONTENT, updateCustomizationSettings);
router.post('/admin/upload/:imageType', protectAdmin, MANAGE, upload.single('image'), uploadCustomizationImage);
router.post('/admin/reset', protectAdmin, MANAGE, resetCustomizationSettings);

// Consultation category cards management
router.post('/admin/consultation-card', protectAdmin, MANAGE, upload.single('image'), addConsultationCard);
router.put('/admin/consultation-card/:cardId', protectAdmin, MANAGE, upload.single('image'), updateConsultationCard);
router.delete('/admin/consultation-card/:cardId', protectAdmin, MANAGE, deleteConsultationCard);

// Self-hosted reels for the home rail (video + optional poster image)
router.post(
  '/admin/reel-videos',
  protectAdmin,
  upload.fields([{ name: 'video', maxCount: 1 }, { name: 'poster', maxCount: 1 }]),
  addReelVideo
);
router.put('/admin/reel-videos/:reelId', protectAdmin, MANAGE, require('../controllers/appCustomizationController').updateReelVideo);
router.delete('/admin/reel-videos/:reelId', protectAdmin, MANAGE, deleteReelVideo);

module.exports = router;
