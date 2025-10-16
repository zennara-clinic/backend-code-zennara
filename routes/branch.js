const express = require('express');
const router = express.Router();
const branchController = require('../controllers/branchController');
const { protect, protectAdmin } = require('../middleware/auth');

// Public routes
router.get('/', branchController.getAllBranches);
router.get('/:id', branchController.getBranchById);
router.get('/:id/slots', branchController.getBranchSlots);

// Admin protected routes (specific routes before parameterized routes)
router.patch('/reorder', protectAdmin, branchController.updateBranchOrder);
router.post('/', protectAdmin, branchController.createBranch);
router.put('/:id', protectAdmin, branchController.updateBranch);
router.patch('/:id/toggle-status', protectAdmin, branchController.toggleBranchStatus);
router.delete('/:id', protectAdmin, branchController.deleteBranch);

module.exports = router;
