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
const { protectAdmin } = require('../middleware/auth');

// Apply admin authentication middleware to all routes
router.use(protectAdmin);

// Statistics route (must be before :id route)
router.get('/statistics', getInventoryStatistics);

// Bulk operations
router.post('/bulk-update-stock', bulkUpdateStock);

// CRUD routes
router.route('/')
  .get(getAllInventory)
  .post(createInventory);

router.route('/:id')
  .get(getInventoryById)
  .put(updateInventory)
  .delete(deleteInventory);

module.exports = router;
