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

// All routes require admin authentication
router.use(protectAdmin);

// Statistics route (must be before /:id)
router.get('/statistics', getFormulationStatistics);

// CRUD routes
router.route('/')
  .get(getAllFormulations)
  .post(createFormulation);

router.route('/:id')
  .get(getFormulationById)
  .put(updateFormulation)
  .delete(deleteFormulation);

module.exports = router;
