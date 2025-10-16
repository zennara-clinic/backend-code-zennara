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
const { protectAdmin } = require('../middleware/auth');

// Public routes
router.get('/', getAllConsultations);
router.get('/featured', getFeaturedConsultations);
router.get('/categories/list', getCategories);
router.get('/category/:category', getConsultationsByCategory);
router.get('/search/:query', searchConsultations);

// Admin-only routes (must be before /:identifier)
router.get('/stats/overview', protectAdmin, getConsultationStats);
router.post('/categories', protectAdmin, createCategory);
router.post('/', protectAdmin, createConsultation);
router.put('/:id', protectAdmin, updateConsultation);
router.delete('/:id', protectAdmin, deleteConsultation);
router.patch('/:id/toggle', protectAdmin, toggleConsultationStatus);

// Dynamic route (must be last)
router.get('/:identifier', getConsultation);

module.exports = router;
