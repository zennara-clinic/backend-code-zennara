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
/**
 * Doctor-facing availability — names and quantities, never a price.
 *
 * Either permission opens it (requirePermission is OR), so anyone who already
 * administers stock keeps access. The point of the separate
 * `inventory.availability` key is the other direction: a dermatologist can be
 * granted this WITHOUT `inventory.view`, and so can never reach the priced
 * inventory list at /api/inventory.
 */
router.get(
  '/availability',
  requirePermission('inventory.availability', 'inventory.view'),
  require('../controllers/inventoryAvailabilityController').getAvailability,
);

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
