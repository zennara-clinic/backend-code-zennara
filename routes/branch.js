const express = require('express');
const router = express.Router();
const branchController = require('../controllers/branchController');
const { protect, protectAdmin, requirePermission } = require('../middleware/auth');

// Public routes
router.get('/', branchController.getAllBranches);
router.get('/:id', branchController.getBranchById);
router.get('/:id/slots', branchController.getBranchSlots);

// Admin protected routes (specific routes before parameterized routes)
router.patch('/reorder', protectAdmin, requirePermission('branches.manage'), branchController.updateBranchOrder);
router.post('/', protectAdmin, requirePermission('branches.manage'), branchController.createBranch);
router.put('/:id', protectAdmin, requirePermission('branches.manage'), branchController.updateBranch);
router.patch('/:id/toggle-status', protectAdmin, requirePermission('branches.manage'), branchController.toggleBranchStatus);
router.delete('/:id', protectAdmin, requirePermission('branches.manage'), branchController.deleteBranch);

module.exports = router;
