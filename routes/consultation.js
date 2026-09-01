const express = require('express');
const router = express.Router();
const {
  getAllConsultations,
  getConsultation,
  getConsultationsByCategory,
  getFeaturedConsultations,
  getCategories,
  createCategory,
  searchConsultations,
  createConsultation,
  updateConsultation,
  deleteConsultation,
  toggleConsultationStatus,
  getConsultationStats
} = require('../controllers/consultationController');
const { protectAdmin, identifyAdmin, requireRole, requirePermission } = require('../middleware/auth');
const MANAGE = requirePermission('services.manage');

// Public routes
router.get('/', identifyAdmin, getAllConsultations);
router.get('/featured', getFeaturedConsultations);
router.get('/categories/list', getCategories);
router.get('/category/:category', getConsultationsByCategory);
router.get('/search/:query', searchConsultations);

// Admin-only routes (must be before /:identifier)
router.get('/stats/overview', protectAdmin, getConsultationStats);
router.post('/categories', protectAdmin, MANAGE, createCategory);
router.post('/', protectAdmin, MANAGE, createConsultation);
router.patch('/reorder', protectAdmin, MANAGE, require('../controllers/consultationController').reorderConsultations);
router.put('/:id', protectAdmin, MANAGE, updateConsultation);
router.delete('/:id', protectAdmin, MANAGE, deleteConsultation);
router.patch('/:id/toggle', protectAdmin, MANAGE, toggleConsultationStatus);

// Dynamic route (must be last)
router.get('/:identifier', identifyAdmin, getConsultation);

module.exports = router;
