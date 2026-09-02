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
const { protectAdmin, requirePermission } = require('../middleware/auth');
const inventoryController = require('../controllers/inventoryController');

// Apply admin authentication middleware to all routes
router.use(protectAdmin);

const VIEW = requirePermission('inventory.view');

// Statistics route (must be before :id route)
router.get('/statistics', VIEW, getInventoryStatistics);

// Ledger + session consumption (therapists may consume; only admins adjust/edit)
router.get('/movements', requirePermission('stockLedger.view', 'inventory.view'), inventoryController.getStockMovements);
router.post('/consume', requirePermission('inventory.manage'), inventoryController.consumeStock);

const MANAGE = requirePermission('inventory.manage');

// Bulk operations
router.post('/bulk-update-stock', MANAGE, bulkUpdateStock);

// CRUD routes
router.route('/')
  .get(VIEW, getAllInventory)
  .post(MANAGE, createInventory);

router.route('/:id')
  .get(VIEW, getInventoryById)
  .put(MANAGE, updateInventory)
  .delete(MANAGE, deleteInventory);

module.exports = router;
