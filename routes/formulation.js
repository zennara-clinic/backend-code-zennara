const express = require('express');
const router = express.Router();
const {
  getAllFormulations,
  getFormulationById,
  createFormulation,
  updateFormulation,
  deleteFormulation,
  getFormulationStatistics
} = require('../controllers/formulationController');
const { protectAdmin } = require('../middleware/auth');

// Public routes - guests can view formulations
router.get('/', getAllFormulations);
router.get('/:id', getFormulationById);

// Admin protected routes
router.get('/statistics', protectAdmin, getFormulationStatistics);
router.post('/', protectAdmin, createFormulation);
router.put('/:id', protectAdmin, updateFormulation);
router.delete('/:id', protectAdmin, deleteFormulation);

module.exports = router;
