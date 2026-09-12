const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const { listMine, getMine, getMineHtml } = require('../controllers/prescriptionController');

// The guest's own prescriptions, read-only. Doctors write them through
// /api/consultation-notes; nothing here can change one.
router.use(protect);
router.get('/', listMine);
router.get('/:id', getMine);
// The signed sheet as a page, in the dermatologist's chosen design — the same
// document the email carried.
router.get('/:id/html', getMineHtml);

module.exports = router;
