const Package = require('../models/Package');
const { clinicDateKey, clinicDayStart } = require('../utils/bookingTime');
const Consultation = require('../models/Consultation');
const mongoose = require('mongoose');

/** A package by Mongo _id, legacy `pkg-…` id, or slug-like name. */
async function findPackage(key) {
  const or = [{ id: key }];
  if (mongoose.Types.ObjectId.isValid(key)) or.unshift({ _id: key });
  return Package.findOne({ $or: or });
}

/**
 * Normalise the services array the panel sends into the stored shape.
 * Accepts either plain ids (legacy) or objects:
 *   { serviceId | _id | id | slug, sessions?, customPrice?, name? }
 * and resolves each against the Consultation catalogue for the name/price.
 */
async function resolveServices(input, customPrices) {
  if (!Array.isArray(input)) return [];
  return Promise.all(input.map(async (item) => {
    const key = typeof item === 'string' ? item : (item.serviceId || item._id || item.id || item.slug);
    if (!key) throw new Error('Each service needs an id');
    const or = [{ id: key }, { slug: key }];
    if (mongoose.Types.ObjectId.isValid(key)) or.unshift({ _id: key });
    const service = await Consultation.findOne({ $or: or });
    if (!service) throw new Error(`Service ${typeof item === 'object' && item.name ? item.name : key} not found`);
    const row = {
      serviceId: service.id || String(service._id),
      serviceName: service.name,
      servicePrice: service.price,
      sessions: typeof item === 'object' && Number(item.sessions) >= 1 ? Math.round(Number(item.sessions)) : 1,
      redemptionOrder: typeof item === 'object' && Number(item.redemptionOrder) >= 1 ? Math.round(Number(item.redemptionOrder)) : 1,
    };
    const custom = typeof item === 'object' && item.customPrice !== undefined && item.customPrice !== null
      ? item.customPrice
      : customPrices && customPrices[key] !== undefined && customPrices[key] !== null ? customPrices[key] : undefined;
    if (custom !== undefined) row.customPrice = Number(custom);
    return row;
  }));
}

// @desc    Create new package
// @route   POST /api/packages
// @access  Private (Admin only)

/**
 * Zenoti "Create package" fields beyond the app's basics. Applied on create and
 * update; every field is optional and validated to a sane range.
 */
function applyPackageExtras(doc, body, by) {
  const b = body || {};
  if (b.code !== undefined) doc.code = String(b.code || '').trim().toUpperCase() || null;
  if (b.category !== undefined) doc.category = String(b.category || 'Default').trim() || 'Default';
  if (b.packageType !== undefined && ['series', 'custom'].includes(b.packageType)) doc.packageType = b.packageType;
  if (b.neverExpires !== undefined) doc.neverExpires = b.neverExpires === true || b.neverExpires === 'true';
  if (b.validityDays !== undefined) doc.validityDays = Number(b.validityDays) > 0 ? Math.round(Number(b.validityDays)) : null;
  if (b.validityStartsAt !== undefined && ['sale', 'firstRedemption'].includes(b.validityStartsAt)) doc.validityStartsAt = b.validityStartsAt;
  if (b.graceDays !== undefined) doc.graceDays = Math.max(0, Math.round(Number(b.graceDays) || 0));
  if (b.closeWhenConsumed !== undefined) doc.closeWhenConsumed = b.closeWhenConsumed === true || b.closeWhenConsumed === 'true';
  if (b.redemption) doc.redemption = { scope: b.redemption.scope === 'centres' ? 'centres' : 'organization', branchIds: Array.isArray(b.redemption.branchIds) ? b.redemption.branchIds.filter((x) => mongoose.Types.ObjectId.isValid(String(x))) : [] };
  if (Array.isArray(b.centrePrices)) doc.centrePrices = b.centrePrices.filter((c) => c && mongoose.Types.ObjectId.isValid(String(c.branchId))).map((c) => ({ branchId: c.branchId, price: c.price === '' || c.price === null || c.price === undefined ? null : Number(c.price), taxPercent: c.taxPercent === '' || c.taxPercent === null || c.taxPercent === undefined ? null : Number(c.taxPercent), available: c.available !== false }));
  if (b.maxFreezes !== undefined) doc.maxFreezes = Math.max(0, Math.round(Number(b.maxFreezes) || 0));
  if (b.maxFreezeDays !== undefined) doc.maxFreezeDays = Math.max(0, Math.round(Number(b.maxFreezeDays) || 0));
  if (b.minPartialPaymentPercent !== undefined) doc.minPartialPaymentPercent = Math.min(100, Math.max(0, Number(b.minPartialPaymentPercent) || 0));
  if (b.agreementText !== undefined) doc.agreementText = String(b.agreementText || '');
  if (b.taxPercent !== undefined) doc.taxPercent = Math.max(0, Number(b.taxPercent) || 0);
  if (b.priceIncludesTax !== undefined) doc.priceIncludesTax = b.priceIncludesTax !== false && b.priceIncludesTax !== 'false';
  if (Array.isArray(b.productBenefits)) doc.productBenefits = b.productBenefits.filter((x) => x && (x.productId || x.name)).map((x) => ({ productId: mongoose.Types.ObjectId.isValid(String(x.productId)) ? x.productId : null, name: x.name || '', qty: Math.max(1, Number(x.qty) || 1) }));
  if (Array.isArray(b.bundledProducts)) doc.bundledProducts = b.bundledProducts.filter((x) => x && (x.productId || x.name)).map((x) => ({ productId: mongoose.Types.ObjectId.isValid(String(x.productId)) ? x.productId : null, name: x.name || '', qty: Math.max(1, Number(x.qty) || 1) }));
  if (Array.isArray(b.redemptionOrders) && Array.isArray(doc.services)) {
    for (const ro of b.redemptionOrders) { const row = doc.services.find((sv) => String(sv.serviceId) === String(ro.serviceId)); if (row) row.redemptionOrder = Math.max(1, Math.round(Number(ro.order) || 1)); }
  }
  doc.$locals.changedBy = by || null;
  return doc;
}

exports.createPackage = async (req, res) => {
  try {
    const {
      name,
      description,
      benefits,
      services,
      consultationServices,
      price,
      image,
      media,
      customPrices,  // Object mapping serviceId to custom price
      zenotiPackageId,
      validityMonths,
    } = req.body;

    // Validate required fields
    if (!name || !description || !price) {
      return res.status(400).json({
        success: false,
        message: 'Please provide package name, description, and price'
      });
    }

    if (!services || services.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Please select at least one service'
      });
    }

    // Generate unique ID
    const id = `pkg-${Date.now()}`;

    const serviceDetails = await resolveServices(services, customPrices);
    const consultationServiceDetails = await resolveServices(consultationServices, customPrices);

    const packageData = await Package.create({
      id,
      name,
      description,
      benefits: benefits || [],
      services: serviceDetails,
      consultationServices: consultationServiceDetails,
      price,
      image: image || '',
      media: media || [],
      isActive: req.body.isActive !== undefined ? !!req.body.isActive : true,
      isPopular: req.body.isPopular !== undefined ? !!req.body.isPopular : false,
      zenotiPackageId: zenotiPackageId || null,
      validityMonths: Number(validityMonths) > 0 ? Number(validityMonths) : 12,
    });
    applyPackageExtras(packageData, req.body, req.admin?.name);
    if (packageData.isModified()) await packageData.save();

    res.status(201).json({
      success: true,
      message: 'Package created successfully',
      data: packageData
    });
  } catch (error) {
    console.error('❌ Create package error:', error);
    
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'A package with this name already exists'
      });
    }

    res.status(500).json({
      success: false,
      message: error.message || 'Failed to create package'
    });
  }
};

// @desc    Get all packages
// @route   GET /api/packages
// @access  Public
exports.getAllPackages = async (req, res) => {
  try {
    const { isActive, includeInactive, search, limit, origin, inCatalogue, packageType, branchId, page } = req.query;
    const q = {};
    // The app only ever sees active packages; staff opt in to the rest.
    if (isActive === 'true' || (!req.admin && includeInactive !== 'true')) q.isActive = true;
    else if (isActive === 'false') q.isActive = false;
    if (search) {
      const rx = { $regex: String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      q.$or = [{ name: rx }, { code: rx }, { description: rx }];
    }
    // Zenoti's catalogue, a guest's custom / retired package, or one of ours.
    if (origin && origin !== 'all') q.origin = origin;
    if (inCatalogue === 'true') q.inCatalogue = true;
    else if (inCatalogue === 'false') q.inCatalogue = false;
    if (packageType && packageType !== 'all') q.packageType = packageType;
    if (branchId && /^[0-9a-f]{24}$/i.test(branchId)) q['centres.branchId'] = branchId;

    const perPage = Math.min(500, parseInt(limit, 10) || 100);
    const pageNo = Math.max(1, parseInt(page, 10) || 1);
    const [packages, total, counts] = await Promise.all([
      Package.find(q).sort({ isPopular: -1, name: 1 }).skip((pageNo - 1) * perPage).limit(perPage),
      Package.countDocuments(q),
      // Tab counts, independent of the current filter, so the tabs never lie.
      Package.aggregate([{ $group: { _id: { origin: '$origin', inCatalogue: '$inCatalogue' }, n: { $sum: 1 } } }]),
    ]);
    const buckets = { catalogue: 0, sold: 0, ours: 0 };
    for (const c of counts) {
      if (c._id.origin === 'panel') buckets.ours += c.n;
      else if (c._id.inCatalogue) buckets.catalogue += c.n;
      else buckets.sold += c.n;
    }

    res.status(200).json({
      success: true,
      count: packages.length,
      total,
      buckets,
      pagination: { page: pageNo, limit: perPage, total, pages: Math.ceil(total / perPage) },
      data: packages
    });
  } catch (error) {
    console.error('❌ Get packages error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch packages'
    });
  }
};

// @desc    Get single package
// @route   GET /api/packages/:id
// @access  Public
exports.getPackage = async (req, res) => {
  try {
    const packageData = await findPackage(req.params.id);

    if (!packageData) {
      return res.status(404).json({
        success: false,
        message: 'Package not found'
      });
    }
    // What the package looked like before this edit — kept in `versions` when benefits or price change.
    packageData.$locals.previousVersionSnapshot = { price: packageData.price, services: packageData.toObject().services, validityMonths: packageData.validityMonths, validityDays: packageData.validityDays, neverExpires: packageData.neverExpires, graceDays: packageData.graceDays };

    res.status(200).json({
      success: true,
      data: packageData
    });
  } catch (error) {
    console.error('❌ Get package error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch package'
    });
  }
};

// @desc    Update package
// @route   PUT /api/packages/:id
// @access  Private (Admin only)
exports.updatePackage = async (req, res) => {
  try {
    const {
      name,
      description,
      benefits,
      services,
      consultationServices,
      price,
      image,
      media,
      isActive,
      isPopular,
      zenotiPackageId,
      customPrices,  // Object mapping serviceId to custom price
      validityMonths,
    } = req.body;

    const packageData = await findPackage(req.params.id);

    if (!packageData) {
      return res.status(404).json({
        success: false,
        message: 'Package not found'
      });
    }

    if (services !== undefined) {
      packageData.services = await resolveServices(services, customPrices);
    }
    if (consultationServices !== undefined) {
      packageData.consultationServices = await resolveServices(consultationServices, customPrices);
    }

    // Update other fields
    if (name) packageData.name = name;
    if (description) packageData.description = description;
    if (benefits !== undefined) packageData.benefits = benefits;
    if (price !== undefined) packageData.price = price;
    if (validityMonths !== undefined && Number(validityMonths) > 0) packageData.validityMonths = Number(validityMonths);
    if (image !== undefined) packageData.image = image;
    if (media !== undefined) packageData.media = media;
    if (isActive !== undefined) packageData.isActive = isActive;
    if (isPopular !== undefined) packageData.isPopular = isPopular;
    if (zenotiPackageId !== undefined) packageData.zenotiPackageId = zenotiPackageId || null;

    applyPackageExtras(packageData, req.body, req.admin?.name);

    await packageData.save();

    res.status(200).json({
      success: true,
      message: 'Package updated successfully',
      data: packageData
    });
  } catch (error) {
    console.error('❌ Update package error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to update package'
    });
  }
};

// @desc    Delete package
// @route   DELETE /api/packages/:id
// @access  Private (Admin only)
exports.deletePackage = async (req, res) => {
  try {
    const found = await findPackage(req.params.id);
    const packageData = found ? await Package.findByIdAndDelete(found._id) : null;

    if (!packageData) {
      return res.status(404).json({
        success: false,
        message: 'Package not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Package deleted successfully'
    });
  } catch (error) {
    console.error('❌ Delete package error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete package'
    });
  }
};

// @desc    Toggle package active status
// @route   PATCH /api/packages/:id/toggle-status
// @access  Private (Admin only)
exports.togglePackageStatus = async (req, res) => {
  try {
    const packageData = await findPackage(req.params.id);

    if (!packageData) {
      return res.status(404).json({
        success: false,
        message: 'Package not found'
      });
    }

    packageData.isActive = !packageData.isActive;
    await packageData.save();

    res.status(200).json({
      success: true,
      message: `Package ${packageData.isActive ? 'activated' : 'deactivated'} successfully`,
      data: packageData
    });
  } catch (error) {
    console.error('❌ Toggle package status error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update package status'
    });
  }
};

// @desc    Get package statistics
// @route   GET /api/packages/stats
// @access  Private (Admin only)
exports.getPackageStats = async (req, res) => {
  try {
    const totalPackages = await Package.countDocuments();
    const activePackages = await Package.countDocuments({ isActive: true });
    
    // Get packages created this month
    // The clinic's month, not the server's timezone.
    const startOfMonth = clinicDayStart(`${clinicDateKey(new Date()).slice(0, 8)}01`);
    
    const newThisMonth = await Package.countDocuments({
      createdAt: { $gte: startOfMonth }
    });

    // Calculate packages sold (total bookings across all packages)
    const packages = await Package.find();
    const packagesSold = packages.reduce((sum, pkg) => sum + (pkg.bookingsCount || 0), 0);

    // Get total customers count from User model
    const User = require('../models/User');
    const totalCustomers = await User.countDocuments({ role: 'patient' });

    res.status(200).json({
      success: true,
      data: {
        totalPackages,
        activePackages,
        totalCustomers,
        packagesSold,
        newThisMonth
      }
    });
  } catch (error) {
    console.error('❌ Get package stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch package statistics'
    });
  }
};
