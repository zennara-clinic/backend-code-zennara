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
      zenotiPackageId: zenotiPackageId || null
    });

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
    const { isActive, includeInactive, search, limit } = req.query;
    const q = {};
    // The app only ever sees active packages; staff opt in to the rest.
    if (isActive === 'true' || (!req.admin && includeInactive !== 'true')) q.isActive = true;
    else if (isActive === 'false') q.isActive = false;
    if (search) q.name = { $regex: String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    let find = Package.find(q).sort({ isPopular: -1, createdAt: -1 });
    if (limit) find = find.limit(Math.min(500, parseInt(limit, 10) || 50));
    const packages = await find;

    res.status(200).json({
      success: true,
      count: packages.length,
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
      customPrices  // Object mapping serviceId to custom price
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
    if (image !== undefined) packageData.image = image;
    if (media !== undefined) packageData.media = media;
    if (isActive !== undefined) packageData.isActive = isActive;
    if (isPopular !== undefined) packageData.isPopular = isPopular;
    if (zenotiPackageId !== undefined) packageData.zenotiPackageId = zenotiPackageId || null;

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
