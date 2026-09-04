const express = require('express');
const router = express.Router();
const { protect, protectAdmin, requirePermission } = require('../middleware/auth');
const ctl = require('../controllers/formTemplateController');

/**
 * Admin-built consultation forms.
 *
 * Building a form and reading its submissions are separate permissions:
 * reception needs to see what a patient answered without being able to change
 * the questions.
 */

// Patients submit their own answers, so this one route is user-authenticated.
router.post('/:id/submissions/mine', protect, ctl.submit);

router.use(protectAdmin);

const VIEW = requirePermission('forms.view', 'forms.manage');
const MANAGE = requirePermission('forms.manage');

router.get('/', VIEW, ctl.list);
// Declared before '/:id' so "for-booking" is not matched as an id.
router.get('/for-booking/:bookingId', VIEW, ctl.forBooking);
router.get('/:id', VIEW, ctl.get);
router.get('/:id/submissions', VIEW, ctl.submissions);

router.post('/', MANAGE, ctl.create);
router.put('/:id', MANAGE, ctl.update);
router.delete('/:id', MANAGE, ctl.remove);

module.exports = router;
