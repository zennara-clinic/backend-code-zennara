const express = require('express');
const router = express.Router();
const {
  getAllConsultations,
  getConsultation,
  getConsultationsByCategory,
  getFeaturedConsultations,
  getCategories,
  searchConsultations
} = require('../controllers/consultationController');

// Public routes
router.get('/', getAllConsultations);
router.get('/featured', getFeaturedConsultations);
router.get('/categories/list', getCategories);
router.get('/category/:category', getConsultationsByCategory);
router.get('/search/:query', searchConsultations);
router.get('/:identifier', getConsultation);

module.exports = router;
