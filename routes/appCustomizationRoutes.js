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
  deleteConsultationCard
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

module.exports = router;
