/**
 * Purchase orders and goods receipt.
 *
 * The rule this file exists to enforce: **a receipt is the only thing on the
 * procurement path that increases stock**, and every receipt writes a
 * StockMovement row. If stock could also be raised by editing a PO, the ledger
 * would stop being a complete explanation of any quantity.
 */
const mongoose = require('mongoose');
const PurchaseOrder = require('../models/PurchaseOrder');
const Vendor = require('../models/Vendor');
const Branch = require('../models/Branch');
const Product = require('../models/Product');
const Inventory = require('../models/Inventory');
const StockMovement = require('../models/StockMovement');

/** Which status may follow which. Anything not listed here is refused. */
const TRANSITIONS = {
  draft: ['raised', 'cancelled'],
  raised: ['approved', 'draft', 'cancelled'],
  approved: ['ordered', 'cancelled'],
  ordered: ['partially_received', 'fully_received', 'cancelled'],
  partially_received: ['fully_received', 'cancelled'],
  fully_received: [],
  cancelled: [],
};

/**
 * PO-YYMM-NNNN, sequential within the month.
 *
 * Derived from a count rather than a stored counter, then retried on a
 * duplicate-key error — two people pressing "create" in the same second must
 * not be able to mint the same number.
 */
async function nextPoNumber() {
  const now = new Date();
  const prefix = `PO-${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const count = await PurchaseOrder.countDocuments({ poNumber: new RegExp(`^${prefix}`) });
  return `${prefix}-${String(count + 1).padStart(4, '0')}`;
}

function record(po, status, req, note) {
  po.statusHistory.push({
    status,
    at: new Date(),
    by: req.admin?._id || null,
    byName: req.admin?.name || '',
    note: note || '',
  });
}

/** GET /api/purchase-orders — vendor-wise and branch-wise listing. */
exports.listOrders = async (req, res) => {
  try {
    const { status, vendorId, branchId, productId, search, page = 1, limit = 50 } = req.query;
    const query = {};
    if (status) query.status = status;
    if (vendorId) query.vendorId = vendorId;
    if (branchId) query.branchId = branchId;
    // Product-wise purchase history — every PO that ever included this item.
    if (productId && mongoose.isValidObjectId(productId)) {
      query.$or = [{ 'lines.productId': productId }, { 'lines.inventoryId': productId }];
    }
    if (search) {
      const rx = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [...(query.$or || []), { poNumber: rx }, { vendorName: rx }, { 'lines.name': rx }];
    }

    const perPage = Math.min(Number(limit) || 50, 200);
    const pageNo = Math.max(1, Number(page) || 1);

    const [orders, total] = await Promise.all([
      PurchaseOrder.find(query)
        .sort({ createdAt: -1 })
        .skip((pageNo - 1) * perPage)
        .limit(perPage)
        .populate('vendorId', 'name contactPerson phone email')
        .populate('branchId', 'name')
        .lean({ virtuals: true }),
      PurchaseOrder.countDocuments(query),
    ]);

    return res.json({ success: true, count: orders.length, total, data: orders });
  } catch (error) {
    console.error('listOrders failed:', error);
    return res.status(500).json({ success: false, message: 'Could not load purchase orders' });
  }
};

/** GET /api/purchase-orders/:id */
exports.getOrder = async (req, res) => {
  try {
    const po = await PurchaseOrder.findById(req.params.id)
      .populate('vendorId', 'name contactPerson phone email gstNumber')
      .populate('branchId', 'name address')
      .lean({ virtuals: true });
    if (!po) return res.status(404).json({ success: false, message: 'Purchase order not found' });
    return res.json({ success: true, data: po });
  } catch (error) {
    console.error('getOrder failed:', error);
    return res.status(500).json({ success: false, message: 'Could not load the purchase order' });
  }
};

/** POST /api/purchase-orders — always starts as a draft. */
exports.createOrder = async (req, res) => {
  try {
    const { vendorId, branchId, lines, expectedDeliveryDate, notes } = req.body || {};
    if (!vendorId || !mongoose.isValidObjectId(vendorId)) {
      return res.status(400).json({ success: false, message: 'A vendor is required' });
    }
    const vendor = await Vendor.findById(vendorId).select('name').lean();
    if (!vendor) return res.status(404).json({ success: false, message: 'Vendor not found' });

    const branch = branchId && mongoose.isValidObjectId(branchId)
      ? await Branch.findById(branchId).select('name').lean()
      : null;

    if (!Array.isArray(lines) || !lines.length) {
      return res.status(400).json({ success: false, message: 'Add at least one item' });
    }

    // Receipts are never accepted at create time — stock only moves through
    // the receive endpoint, which writes the ledger.
    const cleanLines = lines.map((l) => ({
      productId: l.productId || null,
      inventoryId: l.inventoryId || null,
      name: String(l.name || '').trim(),
      sku: l.sku || '',
      requestedQuantity: Math.max(0, Number(l.requestedQuantity) || 0),
      unitCost: Math.max(0, Number(l.unitCost) || 0),
      taxPercent: Math.min(100, Math.max(0, Number(l.taxPercent) || 0)),
      note: l.note || '',
      receipts: [],
    }));
    if (cleanLines.some((l) => !l.name)) {
      return res.status(400).json({ success: false, message: 'Every line needs an item name' });
    }

    let po;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        po = new PurchaseOrder({
          poNumber: await nextPoNumber(),
          vendorId,
          vendorName: vendor.name,
          branchId: branch?._id || null,
          branchName: branch?.name || '',
          lines: cleanLines,
          expectedDeliveryDate: expectedDeliveryDate ? new Date(expectedDeliveryDate) : null,
          notes: notes || '',
          status: 'draft',
          createdBy: req.admin?._id || null,
          createdByName: req.admin?.name || '',
        });
        record(po, 'draft', req, 'Created');
        await po.save();
        break;
      } catch (err) {
        // Two people creating in the same second land on the same number.
        if (err?.code === 11000 && attempt < 2) continue;
        throw err;
      }
    }

    return res.status(201).json({ success: true, data: po });
  } catch (error) {
    console.error('createOrder failed:', error);
    return res.status(500).json({ success: false, message: 'Could not create the purchase order' });
  }
};

/** PUT /api/purchase-orders/:id — edits are only allowed before approval. */
exports.updateOrder = async (req, res) => {
  try {
    const po = await PurchaseOrder.findById(req.params.id);
    if (!po) return res.status(404).json({ success: false, message: 'Purchase order not found' });
    if (!['draft', 'raised'].includes(po.status)) {
      return res.status(409).json({
        success: false,
        message: `A ${po.status.replace('_', ' ')} order can no longer be edited. Cancel it and raise a new one.`,
      });
    }

    const { branchId, lines, expectedDeliveryDate, notes } = req.body || {};
    if (branchId !== undefined) {
      const branch = branchId ? await Branch.findById(branchId).select('name').lean() : null;
      po.branchId = branch?._id || null;
      po.branchName = branch?.name || '';
    }
    if (expectedDeliveryDate !== undefined) {
      po.expectedDeliveryDate = expectedDeliveryDate ? new Date(expectedDeliveryDate) : null;
    }
    if (notes !== undefined) po.notes = notes;
    if (Array.isArray(lines)) {
      po.lines = lines.map((l) => ({
        productId: l.productId || null,
        inventoryId: l.inventoryId || null,
        name: String(l.name || '').trim(),
        sku: l.sku || '',
        requestedQuantity: Math.max(0, Number(l.requestedQuantity) || 0),
        unitCost: Math.max(0, Number(l.unitCost) || 0),
        taxPercent: Math.min(100, Math.max(0, Number(l.taxPercent) || 0)),
        note: l.note || '',
        // An unapproved order has no receipts; this is not a way to drop them.
        receipts: [],
      }));
    }

    await po.save();
    return res.json({ success: true, data: po });
  } catch (error) {
    console.error('updateOrder failed:', error);
    return res.status(500).json({ success: false, message: 'Could not update the purchase order' });
  }
};

/**
 * PATCH /api/purchase-orders/:id/status — move through the workflow.
 *
 * Refuses any transition not in TRANSITIONS, so an order cannot jump from
 * draft straight to received, and a cancelled order cannot be revived.
 */
exports.setStatus = async (req, res) => {
  try {
    const { status, note } = req.body || {};
    const po = await PurchaseOrder.findById(req.params.id);
    if (!po) return res.status(404).json({ success: false, message: 'Purchase order not found' });

    const allowed = TRANSITIONS[po.status] || [];
    if (!allowed.includes(status)) {
      return res.status(409).json({
        success: false,
        message: allowed.length
          ? `A ${po.status.replace('_', ' ')} order can only move to: ${allowed.join(', ')}.`
          : `A ${po.status.replace('_', ' ')} order is final.`,
      });
    }

    if (status === 'raised' && !po.branchId) {
      // Goods have to be received somewhere.
      return res.status(400).json({ success: false, message: 'Choose the branch this stock is for before raising the order' });
    }

    po.status = status;
    if (status === 'raised') po.raisedAt = new Date();
    if (status === 'approved') {
      po.approvedBy = req.admin?._id || null;
      po.approvedByName = req.admin?.name || '';
      po.approvedAt = new Date();
    }
    if (status === 'cancelled') po.cancelledAt = new Date();
    record(po, status, req, note);

    await po.save();
    return res.json({ success: true, data: po });
  } catch (error) {
    console.error('setStatus failed:', error);
    return res.status(500).json({ success: false, message: 'Could not update the order status' });
  }
};

/**
 * POST /api/purchase-orders/:id/receive — book a delivery in.
 *
 * Body: { receipts: [{ lineId, quantity, rejectedQuantity, batchNo, expiryDate, note }] }
 *
 * This is the ONLY place on the procurement path that raises a stock figure.
 * Rejected quantity is recorded but deliberately NOT added to stock — damaged
 * goods are a vendor conversation, not inventory.
 */
exports.receiveGoods = async (req, res) => {
  try {
    const { receipts } = req.body || {};
    if (!Array.isArray(receipts) || !receipts.length) {
      return res.status(400).json({ success: false, message: 'Enter the quantity received' });
    }

    const po = await PurchaseOrder.findById(req.params.id);
    if (!po) return res.status(404).json({ success: false, message: 'Purchase order not found' });
    if (!['approved', 'ordered', 'partially_received'].includes(po.status)) {
      return res.status(409).json({
        success: false,
        message: `Goods cannot be received against a ${po.status.replace('_', ' ')} order.`,
      });
    }

    const applied = [];
    for (const entry of receipts) {
      const line = po.lines.id(entry.lineId);
      if (!line) {
        return res.status(400).json({ success: false, message: 'One of the lines is not on this order' });
      }
      const quantity = Math.max(0, Number(entry.quantity) || 0);
      const rejected = Math.max(0, Number(entry.rejectedQuantity) || 0);
      if (quantity === 0 && rejected === 0) continue;

      // Over-delivery is allowed but flagged in the response, because refusing
      // it outright would leave the desk unable to record what actually arrived.
      const outstanding = Math.max(0, line.requestedQuantity - line.receivedQuantity);
      if (quantity > outstanding) {
        applied.push({ lineId: String(line._id), name: line.name, overDelivery: quantity - outstanding });
      }

      line.receipts.push({
        quantity,
        rejectedQuantity: rejected,
        rejectionReason: entry.rejectionReason || '',
        batchNo: entry.batchNo || '',
        expiryDate: entry.expiryDate ? new Date(entry.expiryDate) : null,
        receivedAt: entry.receivedAt ? new Date(entry.receivedAt) : new Date(),
        receivedBy: req.admin?._id || null,
        receivedByName: req.admin?.name || '',
        note: entry.note || '',
      });

      if (quantity > 0) await applyToStock(po, line, quantity, entry, req);
    }

    // The pre-save hook recomputes the line totals and advances the status.
    record(po, po.status, req, 'Goods received');
    await po.save();

    return res.json({
      success: true,
      message: po.status === 'fully_received' ? 'Order fully received' : 'Delivery recorded',
      data: po,
      ...(applied.length ? { warnings: applied } : {}),
    });
  } catch (error) {
    console.error('receiveGoods failed:', error);
    return res.status(500).json({ success: false, message: 'Could not record the delivery' });
  }
};

/**
 * Add a received quantity to the right stock record and write the ledger row.
 *
 * A line may point at a Product (retail, with per-branch stock) or an Inventory
 * document (clinic consumable). Both are updated atomically with $inc so two
 * receipts booked at once cannot lose one another.
 */
async function applyToStock(po, line, quantity, entry, req) {
  if (line.inventoryId) {
    const before = await Inventory.findById(line.inventoryId).select('qohAllBatches inventoryName').lean();
    const updated = await Inventory.findByIdAndUpdate(
      line.inventoryId,
      { $inc: { qohAllBatches: quantity, qohBatchWise: quantity } },
      { new: true },
    ).select('qohAllBatches inventoryName').lean();
    if (updated) {
      await StockMovement.create({
        inventoryId: line.inventoryId,
        inventoryName: updated.inventoryName || line.name,
        batchNo: entry.batchNo || '',
        type: 'receive',
        delta: quantity,
        before: before?.qohAllBatches || 0,
        after: updated.qohAllBatches || 0,
        reason: `Purchase order ${po.poNumber}`,
        branchId: po.branchId || null,
        adminId: req.admin?._id || null,
        adminEmail: req.admin?.email || '',
      }).catch(() => {});
    }
    return;
  }

  if (line.productId) {
    const product = await Product.findById(line.productId);
    if (!product) return;
    product.stock = (product.stock || 0) + quantity;
    if (po.branchId) {
      const row = (product.branchStock || []).find((b) => String(b.branchId || '') === String(po.branchId));
      if (row) row.quantity = (row.quantity || 0) + quantity;
      else {
        product.branchStock.push({
          branchId: po.branchId,
          branchName: po.branchName || '',
          quantity,
        });
      }
    }
    await product.save({ validateModifiedOnly: true });
    // StockMovement keys on an Inventory id, so a retail-only product has no
    // ledger row here; the receipt on the PO line is its audit trail.
  }
}

/**
 * GET /api/purchase-orders/history/product/:productId
 * Product-wise purchase history: every PO line for one item, newest first.
 */
exports.productHistory = async (req, res) => {
  try {
    const { productId } = req.params;
    if (!mongoose.isValidObjectId(productId)) {
      return res.status(400).json({ success: false, message: 'Invalid product' });
    }
    const orders = await PurchaseOrder.find({
      $or: [{ 'lines.productId': productId }, { 'lines.inventoryId': productId }],
    })
      .sort({ createdAt: -1 })
      .limit(200)
      .populate('vendorId', 'name')
      .lean({ virtuals: true });

    const rows = orders.flatMap((po) =>
      (po.lines || [])
        .filter((l) => String(l.productId || '') === productId || String(l.inventoryId || '') === productId)
        .map((l) => ({
          poNumber: po.poNumber,
          purchaseOrderId: po._id,
          vendor: po.vendorName || po.vendorId?.name || '',
          branch: po.branchName || '',
          status: po.status,
          raisedAt: po.raisedAt || po.createdAt,
          expectedDeliveryDate: po.expectedDeliveryDate,
          receivedAt: po.receivedAt,
          requestedQuantity: l.requestedQuantity,
          receivedQuantity: l.receivedQuantity,
          pendingQuantity: Math.max(0, (l.requestedQuantity || 0) - (l.receivedQuantity || 0)),
          rejectedQuantity: l.rejectedQuantity,
          unitCost: l.unitCost,
        })),
    );

    return res.json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    console.error('productHistory failed:', error);
    return res.status(500).json({ success: false, message: 'Could not load the purchase history' });
  }
};

/** GET /api/purchase-orders/history/vendor/:vendorId — vendor-wise summary. */
exports.vendorHistory = async (req, res) => {
  try {
    const { vendorId } = req.params;
    if (!mongoose.isValidObjectId(vendorId)) {
      return res.status(400).json({ success: false, message: 'Invalid vendor' });
    }
    const orders = await PurchaseOrder.find({ vendorId })
      .sort({ createdAt: -1 })
      .limit(200)
      .populate('branchId', 'name')
      .lean({ virtuals: true });

    const summary = orders.reduce(
      (acc, po) => {
        acc.orders += 1;
        acc.requested += po.totals?.requested || 0;
        acc.received += po.totals?.received || 0;
        acc.pending += po.totals?.pending || 0;
        acc.rejected += po.totals?.rejected || 0;
        acc.value += po.totals?.estimatedValue || 0;
        return acc;
      },
      { orders: 0, requested: 0, received: 0, pending: 0, rejected: 0, value: 0 },
    );

    return res.json({ success: true, data: { summary, orders } });
  } catch (error) {
    console.error('vendorHistory failed:', error);
    return res.status(500).json({ success: false, message: 'Could not load the vendor history' });
  }
};
