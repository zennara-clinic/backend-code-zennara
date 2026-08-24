const express = require('express');
const controller = require('../controllers/dermatologistAvailabilityController');
const { protectAdmin, requireRole } = require('../middleware/auth');

const router = express.Router();

router.get('/', controller.getAll);
router.get('/:doctorId', controller.getOne);
router.put('/:doctorId', protectAdmin, requireRole('super_admin'), controller.upsert);

module.exports = router;
