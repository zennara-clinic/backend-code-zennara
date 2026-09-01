const express = require('express');
const router = express.Router();
const {
  getAllInventory,
  getInventoryById,
  createInventory,
  updateInventory,
  deleteInventory,
  getInventoryStatistics,
  bulkUpdateStock
} = require('../controllers/inventoryController');
const { protectAdmin, requireRole, requirePermission } = require('../middleware/auth');
const inventoryController = require('../controllers/inventoryController');

// Apply admin authentication middleware to all routes
router.use(protectAdmin);

// Statistics route (must be before :id route)
router.get('/statistics', getInventoryStatistics);

// Ledger + session consumption (therapists may consume; only admins adjust/edit)
router.get('/movements', inventoryController.getStockMovements);
router.post('/consume', requireRole('super_admin', 'therapist'), inventoryController.consumeStock);

const MANAGE = requirePermission('inventory.manage');

// Bulk operations
router.post('/bulk-update-stock', MANAGE, bulkUpdateStock);

// CRUD routes
router.route('/')
  .get(getAllInventory)
  .post(MANAGE, createInventory);

router.route('/:id')
  .get(getInventoryById)
  .put(MANAGE, updateInventory)
  .delete(MANAGE, deleteInventory);

module.exports = router;
