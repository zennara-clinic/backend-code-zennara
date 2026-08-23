const Inventory = require('../models/Inventory');
const StockMovement = require('../models/StockMovement');
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

    // Ledger row for a manual quantity edit from the panel.
    try {
      const before = Number(oldInventory?.qohAllBatches) || 0;
      const after = Number(inventory.qohAllBatches) || 0;
      if (before !== after) {
        await StockMovement.create({
          inventoryId: inventory._id,
          inventoryName: inventory.inventoryName,
          batchNo: inventory.batchNo || '',
          type: after > before ? 'receive' : 'adjust',
          delta: after - before,
          before,
          after,
          reason: String(req.body.reason || req.body.movementReason || 'Manual edit'),
          adminId: req.admin?._id || null,
          adminEmail: req.admin?.email || '',
        });
      }
    } catch (ledgerErr) {
      console.error('Stock ledger write failed:', ledgerErr.message);
    }

    // Check for stock changes and send notifications
    try {
      const newQty = inventory.qohAllBatches;
      const oldQty = oldInventory.qohAllBatches;
      const threshold = Number(inventory.reOrderLevel) > 0 ? Number(inventory.reOrderLevel) : 5;

      // Low stock alert (item's own re-order level, else 5 units)
      if (newQty <= threshold && newQty > 0 && oldQty > threshold) {
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


// @desc    Consume stock for a session — atomic, per line, with a ledger row
// @route   POST /api/admin/inventory/consume
// @body    { bookingId?, branchId?, lines: [{ inventoryId, qty, wastedQty?, reason?, batchNo? }] }
// @access  Private (Admin/Therapist)
exports.consumeStock = async (req, res) => {
  try {
    const { bookingId = null, branchId = null } = req.body || {};
    const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];
    if (!lines.length) {
      return res.status(400).json({ success: false, message: 'lines[] is required' });
    }

    const results = [];
    const failures = [];

    for (const line of lines) {
      const qty = Math.max(0, Number(line.qty) || 0);
      const wasted = Math.max(0, Number(line.wastedQty) || 0);
      const need = qty + wasted;
      if (!line.inventoryId || need <= 0) continue;

      // $inc guarded by a "still enough" filter, so two rooms consuming the
      // same item at once cannot both succeed on the last unit.
      const updated = await Inventory.findOneAndUpdate(
        { _id: line.inventoryId, qohAllBatches: { $gte: need } },
        { $inc: { qohAllBatches: -need, qohBatchWise: -need } },
        { new: true }
      );

      if (!updated) {
        const current = await Inventory.findById(line.inventoryId).select('inventoryName qohAllBatches').lean();
        failures.push({
          inventoryId: line.inventoryId,
          name: current?.inventoryName || '',
          available: current?.qohAllBatches ?? 0,
          requested: need,
          message: current ? 'Not enough stock' : 'Item not found',
        });
        continue;
      }

      const before = updated.qohAllBatches + need;
      const rows = [];
      if (qty > 0) rows.push({ type: 'consume', delta: -qty, before, after: before - qty, reason: line.reason || '' });
      if (wasted > 0) rows.push({ type: 'wastage', delta: -wasted, before: before - qty, after: before - need, reason: line.reason || 'wastage' });
      await StockMovement.insertMany(rows.map((r) => ({
        ...r,
        inventoryId: updated._id,
        inventoryName: updated.inventoryName,
        batchNo: line.batchNo || updated.batchNo || '',
        bookingId,
        branchId,
        adminId: req.admin?._id || null,
        adminEmail: req.admin?.email || '',
      })));

      results.push({ inventoryId: updated._id, name: updated.inventoryName, consumed: qty, wasted, remaining: updated.qohAllBatches });

      if (updated.qohAllBatches <= (updated.reOrderLevel || 0)) {
        try {
          const NotificationHelper = require('../utils/notificationHelper');
          if (NotificationHelper.lowStock) await NotificationHelper.lowStock(updated);
        } catch (_) { /* notification is best-effort */ }
      }
    }

    const ok = failures.length === 0;
    return res.status(ok ? 200 : 409).json({
      success: ok,
      message: ok ? 'Stock consumed' : 'Some lines could not be consumed',
      data: { consumed: results, failed: failures },
    });
  } catch (error) {
    console.error('Consume stock error:', error);
    return res.status(500).json({ success: false, message: 'Failed to consume stock', error: error.message });
  }
};

// @desc    Stock movement ledger
// @route   GET /api/admin/inventory/movements?inventoryId=&bookingId=&type=&limit=
// @access  Private (Admin)
exports.getStockMovements = async (req, res) => {
  try {
    const { inventoryId, bookingId, type, startDate, endDate, limit = 100, page = 1 } = req.query;
    const q = {};
    if (inventoryId) q.inventoryId = inventoryId;
    if (bookingId) q.bookingId = bookingId;
    if (type) q.type = type;
    if (startDate || endDate) {
      q.createdAt = {};
      if (startDate) q.createdAt.$gte = new Date(startDate);
      if (endDate) { const d = new Date(endDate); d.setHours(23, 59, 59, 999); q.createdAt.$lte = d; }
    }
    const perPage = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));
    const pageNo = Math.max(1, parseInt(page, 10) || 1);
    const [rows, total] = await Promise.all([
      StockMovement.find(q).sort({ createdAt: -1 }).skip((pageNo - 1) * perPage).limit(perPage).lean(),
      StockMovement.countDocuments(q),
    ]);
    return res.status(200).json({ success: true, count: rows.length, total, pagination: { currentPage: pageNo, totalPages: Math.ceil(total / perPage), total }, data: rows });
  } catch (error) {
    console.error('Stock movements error:', error);
    return res.status(500).json({ success: false, message: 'Failed to load movements', error: error.message });
  }
};
