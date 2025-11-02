const express = require('express');
const router = express.Router();
const {
  createServiceCard,
  getMyServiceCard,
  getServiceCardById,
  addServiceToCard,
  updateService,
  deleteService,
  getServiceHistory,
  getAllServiceCards,
  updateServiceCard,
  deactivateServiceCard
} = require('../controllers/serviceCardController');
const { protect, protectAdmin } = require('../middleware/auth');

// Admin routes
router.post('/admin/create', protectAdmin, createServiceCard);
router.get('/admin/all', protectAdmin, getAllServiceCards);
router.put('/admin/:id', protectAdmin, updateServiceCard);
router.patch('/admin/:id/deactivate', protectAdmin, deactivateServiceCard);
router.post('/admin/:id/services', protectAdmin, addServiceToCard);
router.put('/admin/:cardId/services/:serviceId', protectAdmin, updateService);
router.delete('/admin/:cardId/services/:serviceId', protectAdmin, deleteService);

// Protected user routes
router.use(protect);

router.get('/my-card', getMyServiceCard);
router.get('/:id', getServiceCardById);
router.get('/:id/history', getServiceHistory);

module.exports = router;
