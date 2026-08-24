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
const { protectAdmin, requireRole } = require('../middleware/auth');
const MANAGE = requireRole('super_admin');

// Mounted under /api/admin — staff only. /statistics must precede /:id.
router.use(protectAdmin);
router.get('/statistics', getFormulationStatistics);
router.get('/', getAllFormulations);
router.get('/:id', getFormulationById);
router.post('/', MANAGE, createFormulation);
router.put('/:id', MANAGE, updateFormulation);
router.delete('/:id', MANAGE, deleteFormulation);

module.exports = router;
