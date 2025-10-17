const Package = require('../models/Package');
const Consultation = require('../models/Consultation');

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
      media
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

    // Fetch service details to get prices
    const serviceDetails = await Promise.all(
      services.map(async (serviceId) => {
        const service = await Consultation.findOne({ id: serviceId });
        if (!service) {
          throw new Error(`Service ${serviceId} not found`);
        }
        return {
          serviceId: service.id,
          serviceName: service.name,
          servicePrice: service.price
        };
      })
    );

    // Fetch consultation service details if provided
    let consultationServiceDetails = [];
    if (consultationServices && consultationServices.length > 0) {
      consultationServiceDetails = await Promise.all(
        consultationServices.map(async (serviceId) => {
          const service = await Consultation.findOne({ id: serviceId });
          if (!service) {
            throw new Error(`Consultation service ${serviceId} not found`);
          }
          return {
            serviceId: service.id,
            serviceName: service.name,
            servicePrice: service.price
          };
        })
      );
    }

    const packageData = await Package.create({
      id,
      name,
      description,
      benefits: benefits || [],
      services: serviceDetails,
      consultationServices: consultationServiceDetails,
      price,
      image: image || '',
      media: media || []
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
    const packages = await Package.find().sort({ createdAt: -1 });

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
    const packageData = await Package.findOne({ id: req.params.id });

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
      isPopular
    } = req.body;

    const packageData = await Package.findOne({ id: req.params.id });

    if (!packageData) {
      return res.status(404).json({
        success: false,
        message: 'Package not found'
      });
    }

    // Update service details if services changed
    if (services && services.length > 0) {
      const serviceDetails = await Promise.all(
        services.map(async (serviceId) => {
          const service = await Consultation.findOne({ id: serviceId });
          if (!service) {
            throw new Error(`Service ${serviceId} not found`);
          }
          return {
            serviceId: service.id,
            serviceName: service.name,
            servicePrice: service.price
          };
        })
      );
      packageData.services = serviceDetails;
    }

    // Update consultation services if changed
    if (consultationServices !== undefined) {
      if (consultationServices.length > 0) {
        const consultationServiceDetails = await Promise.all(
          consultationServices.map(async (serviceId) => {
            const service = await Consultation.findOne({ id: serviceId });
            if (!service) {
              throw new Error(`Consultation service ${serviceId} not found`);
            }
            return {
              serviceId: service.id,
              serviceName: service.name,
              servicePrice: service.price
            };
          })
        );
        packageData.consultationServices = consultationServiceDetails;
      } else {
        packageData.consultationServices = [];
      }
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
    const packageData = await Package.findOneAndDelete({ id: req.params.id });

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
    const packageData = await Package.findOne({ id: req.params.id });

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
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    
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
