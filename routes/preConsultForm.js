const express = require('express');
const router = express.Router();
const {
  createOrUpdateForm,
  getUserForms,
  getFormById,
  deleteForm,
  submitForm,
  getAllForms,
  updateFormStatus
} = require('../controllers/preConsultFormController');
const { protect, protectAdmin } = require('../middleware/auth');

// Admin routes
router.get('/admin/all', protectAdmin, getAllForms);
router.patch('/admin/:id/status', protectAdmin, updateFormStatus);

// Protected user routes
router.use(protect);

router.post('/', createOrUpdateForm);
router.get('/', getUserForms);
router.get('/:id', getFormById);
router.delete('/:id', deleteForm);
router.patch('/:id/submit', submitForm);

module.exports = router;
