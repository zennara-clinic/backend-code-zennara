const Inventory = require('../models/Inventory');
const NotificationHelper = require('../utils/notificationHelper');

// Get all inventory items with filters
exports.getAllInventory = async (req, res) => {
  try {
    const { search, category, batchType, stockFilter } = req.query;

    // Build query
    let query = {};

    // Search filter
    if (search) {
      query.$or = [
        { inventoryName: { $regex: search, $options: 'i' } },
        { batchNo: { $regex: search, $options: 'i' } },
        { vendorName: { $regex: search, $options: 'i' } }
      ];
    }

    // Category filter
    if (category && category !== 'All') {
      query.inventoryCategory = category;
    }

    // Batch type filter
    if (batchType && batchType !== 'All') {
      query.batchMaintenance = batchType;
    }

    // Get inventory items
    let inventory = await Inventory.find(query).sort({ createdAt: -1 });

    // Stock filter (applied after query)
    if (stockFilter && stockFilter !== 'all') {
      if (stockFilter === 'in-stock') {
        inventory = inventory.filter(item => item.qohAllBatches >= 10);
      } else if (stockFilter === 'low-stock') {
        inventory = inventory.filter(item => item.qohAllBatches > 0 && item.qohAllBatches < 10);
      } else if (stockFilter === 'out-of-stock') {
        inventory = inventory.filter(item => item.qohAllBatches === 0);
      }
    }

    // Calculate stats
    const stats = {
      total: await Inventory.countDocuments(),
      batchable: await Inventory.countDocuments({ batchMaintenance: 'Batchable' }),
      nonBatchable: await Inventory.countDocuments({ batchMaintenance: 'Non Batchable' }),
      lowStock: await Inventory.countDocuments({ qohAllBatches: { $gt: 0, $lt: 10 } }),
      expired: 0, // Will calculate below
      totalValue: 0
    };

    // Calculate expired and total value
    const allItems = await Inventory.find();
    allItems.forEach(item => {
      // Check expiry
      if (item.batchExpiryDate) {
        const today = new Date();
        const expiry = new Date(item.batchExpiryDate);
        if (expiry < today) {
          stats.expired++;
        }
      }
      // Calculate total value (inventory worth = buying price × stock)
      const buyingPrice = item.inventoryAfterTaxBuyingPrice || item.inventoryBuyingPrice || 0;
      stats.totalValue += buyingPrice * item.qohAllBatches;
    });

    res.status(200).json({
      success: true,
      data: inventory,
      stats,
      count: inventory.length
    });
  } catch (error) {
    console.error('Error fetching inventory:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch inventory items',
      error: error.message
    });
  }
};

// Get single inventory item
exports.getInventoryById = async (req, res) => {
  try {
    const inventory = await Inventory.findById(req.params.id);

    if (!inventory) {
      return res.status(404).json({
        success: false,
        message: 'Inventory item not found'
      });
    }

    res.status(200).json({
      success: true,
      data: inventory
    });
  } catch (error) {
    console.error('Error fetching inventory item:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch inventory item',
      error: error.message
    });
  }
};

// Create new inventory item
exports.createInventory = async (req, res) => {
  try {
    const inventory = await Inventory.create(req.body);

    res.status(201).json({
      success: true,
      message: 'Inventory item created successfully',
      data: inventory
    });
  } catch (error) {
    console.error('Error creating inventory:', error);
    res.status(400).json({
      success: false,
      message: 'Failed to create inventory item',
      error: error.message
    });
  }
};

// Update inventory item
exports.updateInventory = async (req, res) => {
  try {
    const oldInventory = await Inventory.findById(req.params.id);
    const inventory = await Inventory.findByIdAndUpdate(
      req.params.id,
      req.body,
      {
        new: true,
        runValidators: true
      }
    );

    if (!inventory) {
      return res.status(404).json({
        success: false,
        message: 'Inventory item not found'
      });
    }

    // Check for stock changes and send notifications
    try {
      const newQty = inventory.qohAllBatches;
      const oldQty = oldInventory.qohAllBatches;
      
      // Low stock alert (threshold: 5 units)
      if (newQty <= 5 && newQty > 0 && oldQty > 5) {
        await NotificationHelper.lowStockAlert({
          _id: inventory._id,
          product: { name: inventory.inventoryName },
          quantity: newQty,
          branch: { name: inventory.branch || 'Main Branch' }
        });
      }
      
      // Out of stock alert
      if (newQty === 0 && oldQty > 0) {
        await NotificationHelper.outOfStockAlert({
          _id: inventory._id,
          product: { name: inventory.inventoryName },
          branch: { name: inventory.branch || 'Main Branch' }
        });
      }
      
      // Restocked notification (significant increase)
      if (newQty > oldQty + 10) {
        await NotificationHelper.inventoryRestocked({
          _id: inventory._id,
          product: { name: inventory.inventoryName },
          quantity: newQty,
          branch: { name: inventory.branch || 'Main Branch' }
        });
      }
    } catch (notifError) {
      console.error('⚠️ Failed to create inventory notification:', notifError.message);
    }

    res.status(200).json({
      success: true,
      message: 'Inventory item updated successfully',
      data: inventory
    });
  } catch (error) {
    console.error('Error updating inventory:', error);
    res.status(400).json({
      success: false,
      message: 'Failed to update inventory item',
      error: error.message
    });
  }
};

// Delete inventory item
exports.deleteInventory = async (req, res) => {
  try {
    const inventory = await Inventory.findByIdAndDelete(req.params.id);

    if (!inventory) {
      return res.status(404).json({
        success: false,
        message: 'Inventory item not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Inventory item deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting inventory:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete inventory item',
      error: error.message
    });
  }
};

// Get inventory statistics
exports.getInventoryStatistics = async (req, res) => {
  try {
    const stats = {
      total: await Inventory.countDocuments(),
      batchable: await Inventory.countDocuments({ batchMaintenance: 'Batchable' }),
      nonBatchable: await Inventory.countDocuments({ batchMaintenance: 'Non Batchable' }),
      byCategory: {},
      byFormulation: {},
      byVendor: {},
      lowStock: await Inventory.countDocuments({ qohAllBatches: { $gt: 0, $lt: 10 } }),
      outOfStock: await Inventory.countDocuments({ qohAllBatches: 0 })
    };

    // Get unique categories
    const categories = await Inventory.distinct('inventoryCategory');
    for (const category of categories) {
      stats.byCategory[category] = await Inventory.countDocuments({ inventoryCategory: category });
    }

    // Get unique formulations
    const formulations = await Inventory.distinct('formulation');
    for (const formulation of formulations) {
      stats.byFormulation[formulation] = await Inventory.countDocuments({ formulation });
    }

    // Get unique vendors
    const vendors = await Inventory.distinct('vendorName');
    for (const vendor of vendors) {
      stats.byVendor[vendor] = await Inventory.countDocuments({ vendorName: vendor });
    }

    res.status(200).json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('Error fetching inventory statistics:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch inventory statistics',
      error: error.message
    });
  }
};

// Bulk update stock
exports.bulkUpdateStock = async (req, res) => {
  try {
    const { updates } = req.body; // Array of { id, qohAllBatches }

    const updatePromises = updates.map(update =>
      Inventory.findByIdAndUpdate(
        update.id,
        { qohAllBatches: update.qohAllBatches },
        { new: true, runValidators: true }
      )
    );

    await Promise.all(updatePromises);

    res.status(200).json({
      success: true,
      message: 'Stock updated successfully'
    });
  } catch (error) {
    console.error('Error updating stock:', error);
    res.status(400).json({
      success: false,
      message: 'Failed to update stock',
      error: error.message
    });
  }
};
