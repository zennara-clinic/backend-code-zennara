const express = require('express');
const router = express.Router();
const {
  getAllForms,
  getFormById,
  updateFormStatus,
  deleteForm,
  getFormStats
} = require('../controllers/formsController');
const { protectAdmin, requirePermission } = require('../middleware/auth');

// All routes are admin-only
router.use(protectAdmin);
// Patient-submitted forms are part of the patient record.
router.use(requirePermission('patients.view'));

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
