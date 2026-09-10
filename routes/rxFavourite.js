const express = require('express');
const router = express.Router();
const rx = require('../controllers/rxFavouriteController');
const { protectAdmin, requirePermission, auditLog } = require('../middleware/auth');

// Saved prescriptions are clinical records — staff only, same gate as the
// notes they are built from.
router.use(protectAdmin);

// Reading is open to anyone who may read a consultation note; writing needs
// the draft-prescription permission, so reception can look but not save.
router.get('/', requirePermission('consultationNotes.view', 'prescriptions.draft'), rx.list);
// Declared before '/:id' so "recent" is never matched as an id.
router.get('/recent', requirePermission('consultationNotes.view', 'prescriptions.draft'), rx.recent);

router.post('/', requirePermission('prescriptions.draft'), auditLog('RX_FAVOURITE_SAVED', 'CLINICAL'), rx.create);
router.patch('/:id', requirePermission('prescriptions.draft'), rx.update);
router.delete('/:id', requirePermission('prescriptions.draft'), rx.remove);
router.post('/:id/used', requirePermission('prescriptions.draft'), rx.markUsed);

module.exports = router;
