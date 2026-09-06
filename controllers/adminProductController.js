const Product = require('../models/Product');
const AdminAuditLog = require('../models/AdminAuditLog');
const Formulation = require('../models/Formulation');

/** A product's formulation must be one the clinic has defined. */
async function formulationError(name) {
  if (!name) return null;
  const exists = await Formulation.exists({ name: String(name).trim() });
  return exists ? null : `Unknown formulation "${name}" — add it under Formulations first`;
}
const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { s3Client, S3_BUCKET } = require('../config/s3');
const NotificationHelper = require('../utils/notificationHelper');

/**
 * Catalogue attributes the panel may set beyond the original store fields.
 * Mirrors what Zenoti keeps per product (SKU, brand, category, MRP, pack
 * size, HSN, retail vs consumable) plus our own Rx/OTC decision and vendor.
 * Applied on create and update; an undefined key leaves the field alone.
 */
const EXTRA_STRING = ['sku', 'brand', 'productType', 'productCategory', 'productSubCategory', 'packSize', 'hsn', 'rxReason', 'packName', 'vendorName', 'templateStatus', 'batchTracking', 'consumptionOrder'];
const EXTRA_NUMBER = ['mrp', 'lowStockThreshold', 'reorderLevel', 'targetLevel', 'buyingPrice'];
const EXTRA_BOOL = ['isRetail', 'trackStock', 'isAppProduct'];
function applyProductExtras(product, body) {
  if (body.price !== undefined && Number(body.price) !== Number(product.price)) product.priceSource = 'panel';
  for (const key of EXTRA_STRING) {
    if (body[key] !== undefined) product[key] = body[key] === '' || body[key] === null ? null : String(body[key]).trim();
  }
  for (const key of EXTRA_NUMBER) {
    if (body[key] !== undefined) {
      const n = Number(body[key]);
      product[key] = body[key] === '' || body[key] === null || !Number.isFinite(n) ? null : n;
    }
  }
  for (const key of EXTRA_BOOL) {
    if (body[key] !== undefined && body[key] !== null && body[key] !== '') product[key] = body[key] === true || body[key] === 'true';
  }
  if (body.isRx !== undefined) {
    // A decision made in the panel is final until changed in the panel.
    if (body.isRx === null || body.isRx === '') { product.isRx = null; product.rxSource = null; }
    else { product.isRx = body.isRx === true || body.isRx === 'true'; product.rxSource = 'manual'; }
  }
  if (body.vendorId !== undefined) product.vendorId = body.vendorId || null;
  // Template enums must be exact; anything else clears the field rather than failing the save.
  if (product.batchTracking && !['Batchable', 'Non Batchable'].includes(product.batchTracking)) product.batchTracking = /batch/i.test(product.batchTracking) && !/non/i.test(product.batchTracking) ? 'Batchable' : 'Non Batchable';
  if (product.consumptionOrder && !['FIFO', 'ByExpiry'].includes(product.consumptionOrder)) product.consumptionOrder = /exp/i.test(product.consumptionOrder) ? 'ByExpiry' : 'FIFO';
  if (body.stock !== undefined && Number.isFinite(Number(body.stock))) { product.stockSource = 'panel'; product.stockUpdatedAt = new Date(); }
}

// @desc    Get all products (Admin)
// @route   GET /api/admin/products
// @access  Private/Admin
exports.getAllProducts = async (req, res) => {
  try {
    const { formulation, search, isActive, isPopular, sort } = req.query;
    
    // Build query
    const query = {};
    
    if (formulation && formulation !== 'All') {
      query.formulation = formulation;
    }
    
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
        { OrgName: { $regex: search, $options: 'i' } },
        { code: { $regex: search, $options: 'i' } },
        { sku: { $regex: search, $options: 'i' } },
        { productCategory: { $regex: search, $options: 'i' } },
      ];
    }

    /*
     * Zenoti's product master splits into what the app can sell and what only
     * the clinic uses. `kind` mirrors that split so the panel can show one tab
     * per group instead of 708 rows in a single list.
     *   retail     — sellable stock (isRetail true)
     *   consumable — treatment-room stock (isRetail false)
     *   rx         — prescription items, wherever they sit
     *   unpriced   — mirrored but never priced or published
     */
    const { kind, branchId, category, catalogue, subCategory, hsn, vendor, status: templateStatus, stockFilter } = req.query;
    /*
     * `catalogue=app` (the panel's default) shows only what Commerce sells —
     * the curated OTC list — not Zenoti's whole master. `catalogue=all` opens
     * the full master for the Inventory side of the house.
     */
    if (catalogue === 'app') query.isAppProduct = true;
    else if (catalogue === 'master') query.isAppProduct = { $ne: true };
    if (subCategory && subCategory !== 'All') query.productSubCategory = subCategory;
    if (hsn) query.hsn = { $regex: String(hsn).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    if (vendor && vendor !== 'All') query.vendorName = { $regex: `^${String(vendor).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' };
    if (templateStatus && templateStatus !== 'All') query.templateStatus = templateStatus;
    if (stockFilter === 'out') query.stock = { $lte: 0 };
    else if (stockFilter === 'low') query.$expr = { $and: [{ $gt: ['$stock', 0] }, { $lte: ['$stock', { $ifNull: ['$reorderLevel', 5] }] }] };
    else if (stockFilter === 'in') query.$expr = { $gt: ['$stock', { $ifNull: ['$reorderLevel', 5] }] };
    if (kind === 'retail') query.isRetail = true;
    else if (kind === 'consumable') query.isRetail = false;
    else if (kind === 'rx') query.isRx = true;
    else if (kind === 'unpriced') { query.$and = [...(query.$and || []), { $or: [{ price: 0 }, { price: null }] }]; }
    if (branchId && /^[0-9a-f]{24}$/i.test(branchId)) query['centres.branchId'] = branchId;
    if (category && category !== 'All') query.productCategory = category;
    
    if (isActive !== undefined) {
      query.isActive = isActive === 'true';
    }
    
    if (isPopular !== undefined) {
      query.isPopular = isPopular === 'true';
    }
    
    // Build sort
    let sortOption = {};
    switch (sort) {
      case 'name_asc':
        sortOption = { name: 1 };
        break;
      case 'name_desc':
        sortOption = { name: -1 };
        break;
      case 'price_asc':
        sortOption = { price: 1 };
        break;
      case 'price_desc':
        sortOption = { price: -1 };
        break;
      case 'stock_asc':
        sortOption = { stock: 1 };
        break;
      case 'stock_desc':
        sortOption = { stock: -1 };
        break;
      default:
        sortOption = { createdAt: -1 };
    }
    
    const products = await Product.find(query).sort(sortOption);

    // Tab counts, independent of the current filter, so the tabs never lie.
    const [allCount, retailCount, consumableCount, rxCount, unpricedCount, appCount, facets] = await Promise.all([
      Product.countDocuments({}),
      Product.countDocuments({ isRetail: true }),
      Product.countDocuments({ isRetail: false }),
      Product.countDocuments({ isRx: true }),
      Product.countDocuments({ $or: [{ price: 0 }, { price: null }] }),
      Product.countDocuments({ isAppProduct: true }),
      // Filter menus for the catalogue view: distinct categories, sub-categories, vendors, statuses.
      Product.aggregate([{ $match: catalogue === 'app' ? { isAppProduct: true } : {} }, { $group: { _id: null, categories: { $addToSet: '$productCategory' }, subCategories: { $addToSet: '$productSubCategory' }, vendors: { $addToSet: '$vendorName' }, statuses: { $addToSet: '$templateStatus' }, hsn: { $addToSet: '$hsn' } } }]),
    ]);
    const clean = (arr) => (arr || []).filter((x) => x && String(x).trim()).sort();
    const f0 = facets[0] || {};

    // Calculate stats
    const stats = {
      total: products.length,
      active: products.filter(p => p.isActive).length,
      inactive: products.filter(p => !p.isActive).length,
      lowStock: products.filter(p => p.stock < 10).length,
      outOfStock: products.filter(p => p.stock === 0).length,
      totalValue: products.reduce((sum, p) => sum + (p.price * p.stock), 0)
    };
    
    res.json({
      success: true,
      data: products,
      buckets: { all: allCount, retail: retailCount, consumable: consumableCount, rx: rxCount, unpriced: unpricedCount, app: appCount },
      facets: { categories: clean(f0.categories), subCategories: clean(f0.subCategories), vendors: clean(f0.vendors), statuses: clean(f0.statuses), hsn: clean(f0.hsn) },
      stats
    });
  } catch (error) {
    console.error('Get all products error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch products',
      error: error.message
    });
  }
};

// @desc    Get single product by ID (Admin)
// @route   GET /api/admin/products/:id
// @access  Private/Admin
exports.getProductById = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    
    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }
    
    res.json({
      success: true,
      data: product
    });
  } catch (error) {
    console.error('Get product by ID error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch product',
      error: error.message
    });
  }
};

// @desc    Create new product
// @route   POST /api/admin/products
// @access  Private/Admin
exports.createProduct = async (req, res) => {
  try {
    const {
      name,
      description,
      formulation,
      OrgName,
      code,
      price,
      gstPercentage,
      image,
      stock,
      isActive,
      isPopular
    } = req.body;

    // Validation
    if (!name || !description || !formulation || !OrgName || !price) {
      return res.status(400).json({
        success: false,
        message: 'Please provide all required fields (name, description, formulation, OrgName, price)'
      });
    }

    const fErr = await formulationError(formulation);
    if (fErr) return res.status(400).json({ success: false, message: fErr });

    // Create product
    const product = new Product({
      name,
      description,
      formulation,
      OrgName,
      code: code && code !== '' ? code : null, // Convert empty string to null
      price,
      gstPercentage: gstPercentage || 18,
      image,
      stock: stock || 0,
      isActive: isActive !== undefined ? isActive : true,
      isPopular: isPopular || false
    });
    applyProductExtras(product, req.body);
    await product.save();

    // Create notification for new product
    try {
      await NotificationHelper.productCreated({
        _id: product._id,
        name: product.name,
        price: product.price
      });
      console.log('🔔 Product creation notification created');
    } catch (notifError) {
      console.error('⚠️ Failed to create notification:', notifError.message);
    }

    res.status(201).json({
      success: true,
      message: 'Product created successfully',
      data: product
    });
  } catch (error) {
    console.error('Create product error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create product',
      error: error.message
    });
  }
};

// @desc    Update product
// @route   PUT /api/admin/products/:id
// @access  Private/Admin
exports.updateProduct = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    
    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    console.log('Update product request body:', req.body);
    console.log('Code from request:', req.body.code);

    const {
      name,
      description,
      formulation,
      OrgName,
      code,
      price,
      gstPercentage,
      image,
      stock,
      isActive,
      isPopular
    } = req.body;

    if (formulation) {
      const fErr = await formulationError(formulation);
      if (fErr) return res.status(400).json({ success: false, message: fErr });
    }

    // Update fields
    if (name) product.name = name;
    if (description) product.description = description;
    if (formulation) product.formulation = formulation;
    if (OrgName) product.OrgName = OrgName;
    if (code !== undefined) {
      // Convert empty string to null to avoid unique constraint issues
      product.code = (code === '' || code === null) ? null : code;
      console.log('Setting product code to:', product.code);
    }
    if (price !== undefined) product.price = price;
    if (gstPercentage !== undefined) product.gstPercentage = gstPercentage;
    if (image !== undefined) product.image = image; // Allow empty string to clear image
    if (stock !== undefined) product.stock = stock;
    if (isActive !== undefined) product.isActive = isActive;
    if (isPopular !== undefined) product.isPopular = isPopular;
    applyProductExtras(product, req.body);

    // Additional safety check: ensure code is null if empty string before saving
    if (product.code === '') {
      product.code = null;
    }

    console.log('Attempting to save product with data:', {
      code: product.code,
      name: product.name,
      formulation: product.formulation
    });
    
    await product.save();
    console.log('Product saved successfully with code:', product.code);

    // Create notification for product update
    try {
      await NotificationHelper.productUpdated({
        _id: product._id,
        name: product.name
      });
      console.log('🔔 Product update notification created');
    } catch (notifError) {
      console.error('⚠️ Failed to create notification:', notifError.message);
    }

    res.json({
      success: true,
      message: 'Product updated successfully',
      data: product
    });
  } catch (error) {
    console.error('Update product error:', error);
    console.error('Error name:', error.name);
    console.error('Error code:', error.code);
    console.error('Error details:', {
      name: error.name,
      code: error.code,
      keyPattern: error.keyPattern,
      keyValue: error.keyValue
    });
    
    // Check for duplicate key error (MongoDB error code 11000)
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return res.status(400).json({
        success: false,
        message: `A product with ${field} "${value}" already exists. Please use a different ${field} or leave it empty.`,
        error: `Duplicate ${field}`,
        field: field,
        value: value
      });
    }
    
    // Check for validation errors
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        message: 'Validation error: ' + messages.join(', '),
        error: messages.join(', '),
        validationErrors: messages
      });
    }
    
    res.status(500).json({
      success: false,
      message: 'Failed to update product',
      error: error.message
    });
  }
};

// @desc    Delete product
// @route   DELETE /api/admin/products/:id
// @access  Private/Admin
exports.deleteProduct = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    
    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Delete image from S3 if it's an S3 URL
    if (product.image && product.image.includes('.s3.')) {
      try {
        // Extract the key from the S3 URL
        const urlParts = product.image.split('.amazonaws.com/');
        if (urlParts.length > 1) {
          const fileKey = urlParts[1];
          const deleteParams = {
            Bucket: S3_BUCKET,
            Key: fileKey
          };
          await s3Client.send(new DeleteObjectCommand(deleteParams));
        }
      } catch (s3Error) {
        console.error('S3 delete error:', s3Error);
        // Continue with product deletion even if image deletion fails
      }
    }

    await product.deleteOne();

    res.json({
      success: true,
      message: 'Product deleted successfully'
    });
  } catch (error) {
    console.error('Delete product error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete product',
      error: error.message
    });
  }
};

// @desc    Toggle product active status
// @route   PATCH /api/admin/products/:id/toggle-status
// @access  Private/Admin
exports.toggleProductStatus = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    
    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    product.isActive = !product.isActive;
    await product.save();

    res.json({
      success: true,
      message: `Product ${product.isActive ? 'activated' : 'deactivated'} successfully`,
      data: product
    });
  } catch (error) {
    console.error('Toggle product status error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to toggle product status',
      error: error.message
    });
  }
};

// @desc    Update product stock
// @route   PATCH /api/admin/products/:id/stock
// @access  Private/Admin
exports.updateStock = async (req, res) => {
  try {
    const { stock } = req.body;
    
    if (stock === undefined || stock < 0) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a valid stock value'
      });
    }

    const product = await Product.findById(req.params.id);
    
    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    product.stock = stock;
    await product.save();

    res.json({
      success: true,
      message: 'Stock updated successfully',
      data: product
    });
  } catch (error) {
    console.error('Update stock error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update stock',
      error: error.message
    });
  }
};

// @desc    Bulk update products
// @route   PATCH /api/admin/products/bulk-update
// @access  Private/Admin
exports.bulkUpdateProducts = async (req, res) => {
  try {
    const { productIds, updates } = req.body;

    if (!productIds || !Array.isArray(productIds) || productIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Please provide product IDs'
      });
    }

    if (!updates || Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Please provide updates'
      });
    }

    const result = await Product.updateMany(
      { _id: { $in: productIds } },
      { $set: updates }
    );

    res.json({
      success: true,
      message: `${result.modifiedCount} products updated successfully`,
      modifiedCount: result.modifiedCount
    });
  } catch (error) {
    console.error('Bulk update error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to bulk update products',
      error: error.message
    });
  }
};

// @desc    Get product statistics
// @route   GET /api/admin/products/statistics
// @access  Private/Admin
exports.getProductStatistics = async (req, res) => {
  try {
    const products = await Product.find({});
    
    const stats = {
      total: products.length,
      active: products.filter(p => p.isActive).length,
      inactive: products.filter(p => !p.isActive).length,
      popular: products.filter(p => p.isPopular).length,
      lowStock: products.filter(p => p.stock > 0 && p.stock < 10).length,
      outOfStock: products.filter(p => p.stock === 0).length,
      totalStock: products.reduce((sum, p) => sum + p.stock, 0),
      totalValue: products.reduce((sum, p) => sum + (p.price * p.stock), 0),
      avgPrice: products.length > 0 ? products.reduce((sum, p) => sum + p.price, 0) / products.length : 0,
      avgRating: products.length > 0 ? products.reduce((sum, p) => sum + p.rating, 0) / products.length : 0,
      byFormulation: {}
    };

    // Group by formulation
    products.forEach(product => {
      if (!stats.byFormulation[product.formulation]) {
        stats.byFormulation[product.formulation] = {
          count: 0,
          stock: 0,
          value: 0
        };
      }
      stats.byFormulation[product.formulation].count++;
      stats.byFormulation[product.formulation].stock += product.stock;
      stats.byFormulation[product.formulation].value += product.price * product.stock;
    });

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('Get statistics error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch statistics',
      error: error.message
    });
  }
};


/* ------------------------------------------------------------------------ */
/* App Stock template — import / export for the Commerce catalogue           */
/* ------------------------------------------------------------------------ */
/*
 * The sheet the pharmacy team maintains is the source of truth for what the
 * app sells and at what stock level. Import matches each row to a product
 * that already exists here (by code, then by exact name) and writes OUR
 * fields only. It never creates anything in Zenoti and never calls Zenoti —
 * the import is one-directional by design (product master lives in Zenoti;
 * commerce facts — price, stock, HSN, vendor, re-order levels — live here).
 */
const { parseAppStockWorkbook, toTemplateRows, TEMPLATE_HEADERS } = require('../utils/appStockTemplate');

function sheetsFromUpload(file) {
  if (!file) throw Object.assign(new Error('Attach the App Stock template (.xlsx or .csv).'), { status: 400 });
  const XLSX = require('xlsx');
  const name = String(file.originalname || '').toLowerCase();
  if (name.endsWith('.csv')) {
    const { parseCsv } = require('../utils/bulkCsv');
    return [{ name: 'CSV', rows: parseCsv(file.buffer.toString('utf8')) }];
  }
  const wb = XLSX.read(file.buffer, { type: 'buffer' });
  return wb.SheetNames.map((n) => ({ name: n, rows: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '' }) }));
}

async function matchTemplateRows(sheets) {
  const all = await Product.find({}).select('_id name code sku isActive isAppProduct isRx price stock image').lean();
  const byCode = new Map(); const byName = new Map();
  for (const p of all) {
    if (p.code) byCode.set(String(p.code).trim().toUpperCase(), p);
    if (p.sku) byCode.set(String(p.sku).trim().toUpperCase(), p);
    byName.set(String(p.name).trim().toLowerCase(), p);
  }
  const plan = new Map(); // productId → { product, template?, otc?, rx? }
  const unmatched = [];
  for (const sheet of sheets) {
    for (const row of sheet.rows) {
      const hit = (row.code && byCode.get(row.code.toUpperCase())) || (row.name && byName.get(row.name.toLowerCase())) || null;
      if (!hit) { unmatched.push(`${row.code || ''} ${row.name || ''}`.trim()); continue; }
      const entry = plan.get(String(hit._id)) || { product: hit };
      if (sheet.kind === 'template') entry.template = row;
      else if (sheet.classification === 'rx') entry.rx = row;
      else entry.otc = row;
      plan.set(String(hit._id), entry);
    }
  }
  return { plan, unmatched };
}

/** Which of our fields a row would change on a product (for the preview and the audit). */
function changesFor(entry) {
  const fields = [];
  const t = entry.template; const c = entry.otc || entry.rx;
  const p = entry.product;
  if (t) fields.push('stock', 'price', 'buyingPrice', 'reorderLevel', 'targetLevel', 'gst', 'vendor', 'pack', 'batchTracking');
  if (c) { if (c.hsn) fields.push('hsn'); if (c.subCategory) fields.push('subCategory'); if (!t && c.stock !== null) fields.push('stock'); if (c.mrp) fields.push('mrp'); }
  if (entry.otc && !p.isAppProduct) fields.push('→ commerce catalogue');
  if (entry.otc && !p.isActive && (Number(p.price) > 0 || (t && t.price) || entry.otc.mrp)) fields.push('→ live in app');
  if (entry.rx && p.isRx !== true) fields.push('→ Rx');
  if (entry.rx && (p.isAppProduct || p.isActive)) fields.push('→ off the app');
  return fields;
}

function summarisePlan(plan, unmatched, sheets) {
  const out = { sheets: sheets.map((s) => ({ sheetName: s.sheetName, kind: s.kind, classification: s.classification, rows: s.rows.length, skipped: s.skipped })), matched: plan.size, unmatched: unmatched.length, willUpdate: 0, willPublish: 0, willUnpublish: 0, rxFlagged: 0, samples: { unmatched: unmatched.slice(0, 10), changes: [] } };
  for (const e of plan.values()) {
    const f = changesFor(e);
    if (f.length) out.willUpdate += 1;
    if (f.includes('→ live in app')) out.willPublish += 1;
    if (f.includes('→ off the app')) out.willUnpublish += 1;
    if (e.rx) out.rxFlagged += 1;
    if (out.samples.changes.length < 12 && f.length) out.samples.changes.push({ name: e.product.name, code: e.product.code || e.product.sku || null, fields: f });
  }
  return out;
}

// POST /api/admin/products/app-stock/preview  (multipart: file)
exports.appStockPreview = async (req, res) => {
  try {
    const sheets = parseAppStockWorkbook(sheetsFromUpload(req.file));
    if (!sheets.length) return res.status(400).json({ success: false, message: 'That file is not the App Stock template or the Rx/OTC classification sheet. Export the template from this page and fill it in.' });
    const { plan, unmatched } = await matchTemplateRows(sheets);
    return res.json({ success: true, data: summarisePlan(plan, unmatched, sheets) });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message || 'Could not read that file' });
  }
};

/** Apply the plan. Exported so the one-time bootstrap script can reuse it. */
async function applyAppStockPlan(plan, { adminName = 'import' } = {}) {
  const now = new Date();
  const stats = { applied: 0, published: 0, unpublished: 0, rxFlagged: 0 };
  for (const e of plan.values()) {
    const product = await Product.findById(e.product._id);
    if (!product) continue;
    const t = e.template; const c = e.otc || e.rx;
    const before = product.toObject();
    if (t) {
      if (t.category) product.productCategory = t.category;
      if (t.formulation) product.formulation = t.formulation;
      if (t.brand) product.brand = t.brand;
      if (t.batchTracking) product.batchTracking = /non/i.test(t.batchTracking) ? 'Non Batchable' : 'Batchable';
      if (t.consumptionOrder) product.consumptionOrder = /exp/i.test(t.consumptionOrder) ? 'ByExpiry' : 'FIFO';
      if (t.stock !== null) { product.stock = Math.max(0, t.stock); product.trackStock = true; product.stockSource = 'template'; product.stockUpdatedAt = now; }
      if (t.reorderLevel !== null) { product.reorderLevel = t.reorderLevel; product.lowStockThreshold = t.reorderLevel; }
      if (t.targetLevel !== null) product.targetLevel = t.targetLevel;
      if (t.packName) product.packName = t.packName;
      if (t.packSize) product.packSize = String(t.packSize);
      if (t.buyingPrice !== null) product.buyingPrice = t.buyingPrice;
      if (t.price !== null && t.price > 0) { product.price = t.price; product.priceSource = 'template'; }
      if (t.gst !== null) product.gstPercentage = t.gst;
      if (t.vendorName) product.vendorName = t.vendorName;
      if (t.templateStatus) product.templateStatus = t.templateStatus;
      if (t.code && !product.code) product.code = t.code;
    }
    if (c) {
      if (c.category && !product.productCategory) product.productCategory = c.category;
      if (c.subCategory) product.productSubCategory = c.subCategory;
      if (c.hsn) product.hsn = c.hsn;
      if (c.vendorName && !product.vendorName) product.vendorName = c.vendorName;
      if (c.mrp) product.mrp = c.mrp;
      if (!t && c.stock !== null) { product.stock = Math.max(0, c.stock); product.trackStock = true; product.stockSource = 'template'; product.stockUpdatedAt = now; }
      if (!(Number(product.price) > 0) && c.mrp) { product.price = c.mrp; product.priceSource = 'template'; }
    }
    if (e.otc) {
      product.isAppProduct = true;
      product.isRetail = true;
      product.isRx = false; product.rxSource = 'import'; product.rxReason = e.otc.reason || 'OTC — sell directly (pharmacy sheet)';
      if (Number(product.price) > 0 && !product.isActive) { product.isActive = true; stats.published += 1; }
    }
    if (e.rx) {
      product.isRx = true; product.rxSource = 'import'; product.rxReason = e.rx.reason || 'Prescription required (pharmacy sheet)';
      if (product.isAppProduct || product.isActive) stats.unpublished += 1;
      product.isAppProduct = false; product.isActive = false;
      stats.rxFlagged += 1;
    }
    if (JSON.stringify(product.toObject()) !== JSON.stringify(before)) { await product.save({ validateModifiedOnly: true }); stats.applied += 1; }
  }
  void adminName;
  return stats;
}
exports.applyAppStockPlan = applyAppStockPlan;
exports.matchTemplateRows = matchTemplateRows;

// POST /api/admin/products/app-stock/import  (multipart: file)
exports.appStockImport = async (req, res) => {
  try {
    const sheets = parseAppStockWorkbook(sheetsFromUpload(req.file));
    if (!sheets.length) return res.status(400).json({ success: false, message: 'That file is not the App Stock template or the Rx/OTC classification sheet.' });
    const { plan, unmatched } = await matchTemplateRows(sheets);
    const summary = summarisePlan(plan, unmatched, sheets);
    const stats = await applyAppStockPlan(plan, { adminName: req.admin?.name });
    await AdminAuditLog.logAction({ adminId: req.admin?._id, adminEmail: req.admin?.email, action: 'BULK_IMPORT', resource: 'PRODUCT', details: { source: 'app-stock-template', file: req.file?.originalname, ...stats, unmatched: unmatched.length }, ipAddress: req.adminIp || req.ip, userAgent: req.adminUserAgent, status: 'SUCCESS' }).catch(() => {});
    return res.json({ success: true, message: `${stats.applied} product${stats.applied === 1 ? '' : 's'} updated${stats.published ? `, ${stats.published} published to the app` : ''}${stats.unpublished ? `, ${stats.unpublished} taken off the app (Rx)` : ''}${unmatched.length ? `, ${unmatched.length} rows not found` : ''}.`, data: { ...summary, ...stats } });
  } catch (error) {
    console.error('app stock import failed:', error);
    return res.status(error.status || 500).json({ success: false, message: error.message || 'Could not import that file' });
  }
};

// GET /api/admin/products/app-stock/export?catalogue=app|all
exports.appStockExport = async (req, res) => {
  try {
    const XLSX = require('xlsx');
    const q = req.query.catalogue === 'all' ? {} : { isAppProduct: true };
    const products = await Product.find(q).sort({ productCategory: 1, name: 1 }).lean();
    const stamp = new Date().toISOString().slice(0, 10);
    const aoa = [
      [`Zennara — App Stock Template (Commerce catalogue, exported ${stamp})`],
      ['Edit and re-import from Commerce › Products › Import. Code is the match key; Opening Quantity becomes the stock on hand. Nothing here is written to Zenoti.'],
      TEMPLATE_HEADERS,
      ...toTemplateRows(products),
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = TEMPLATE_HEADERS.map((h) => ({ wch: Math.max(12, h.length + 4) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Stock_Import_Template');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="AppStock_Template_${req.query.catalogue === 'all' ? 'AllProducts' : 'Commerce'}_${stamp}.xlsx"`);
    return res.send(buf);
  } catch (error) {
    console.error('app stock export failed:', error);
    return res.status(500).json({ success: false, message: 'Could not build the export' });
  }
};
