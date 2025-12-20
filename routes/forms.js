const express = require('express');
const router = express.Router();
const {
  getAllForms,
  getFormById,
  updateFormStatus,
  deleteForm,
  getFormStats
} = require('../controllers/formsController');
const { protectAdmin } = require('../middleware/auth');

// All routes are admin-only
router.use(protectAdmin);

// Get form statistics
router.get('/stats', getFormStats);

// Get all forms
router.get('/', getAllForms);

// Get form by ID and type
router.get('/:type/:id', getFormById);

// Update form status
router.patch('/:type/:id/status', updateFormStatus);

// Delete form
router.delete('/:type/:id', deleteForm);

module.exports = router;
