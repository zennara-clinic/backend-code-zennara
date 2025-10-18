const Vendor = require('../models/Vendor');
const Product = require('../models/Product');

// @desc    Get all vendors
// @route   GET /api/vendors
// @access  Private (Admin)
exports.getVendors = async (req, res) => {
  try {
    const { search, status } = req.query;
    
    let query = {};
    
    // Search filter
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { contactPerson: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } }
      ];
    }
    
    // Status filter
    if (status && status !== 'all') {
      query.status = status;
    }
    
    const vendors = await Vendor.find(query).sort({ createdAt: -1 });
    
    // Get products count for each vendor
    const vendorsWithCount = await Promise.all(
      vendors.map(async (vendor) => {
        const productsCount = await Product.countDocuments({ vendor: vendor._id });
        return {
          ...vendor.toObject(),
          productsSupplied: productsCount
        };
      })
    );
    
    res.json({
      success: true,
      data: vendorsWithCount
    });
  } catch (error) {
    console.error('Get vendors error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch vendors',
      error: error.message
    });
  }
};

// @desc    Get single vendor
// @route   GET /api/vendors/:id
// @access  Private (Admin)
exports.getVendor = async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id);
    
    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: 'Vendor not found'
      });
    }
    
    // Get products supplied by this vendor
    const productsCount = await Product.countDocuments({ vendor: vendor._id });
    
    res.json({
      success: true,
      data: {
        ...vendor.toObject(),
        productsSupplied: productsCount
      }
    });
  } catch (error) {
    console.error('Get vendor error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch vendor',
      error: error.message
    });
  }
};

// @desc    Create vendor
// @route   POST /api/vendors
// @access  Private (Admin)
exports.createVendor = async (req, res) => {
  try {
    const {
      name,
      contactPerson,
      email,
      phone,
      address,
      city,
      state,
      pincode,
      gstNumber,
      panNumber,
      bankDetails,
      status,
      rating,
      notes
    } = req.body;
    
    // Check if vendor with same email already exists
    const existingVendor = await Vendor.findOne({ email });
    if (existingVendor) {
      return res.status(400).json({
        success: false,
        message: 'Vendor with this email already exists'
      });
    }
    
    const vendor = await Vendor.create({
      name,
      contactPerson,
      email,
      phone,
      address,
      city,
      state,
      pincode,
      gstNumber,
      panNumber,
      bankDetails,
      status: status || 'Active',
      rating: rating || 0,
      notes
    });
    
    res.status(201).json({
      success: true,
      message: 'Vendor created successfully',
      data: vendor
    });
  } catch (error) {
    console.error('Create vendor error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create vendor',
      error: error.message
    });
  }
};

// @desc    Update vendor
// @route   PUT /api/vendors/:id
// @access  Private (Admin)
exports.updateVendor = async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id);
    
    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: 'Vendor not found'
      });
    }
    
    // Check if email is being changed and if new email already exists
    if (req.body.email && req.body.email !== vendor.email) {
      const existingVendor = await Vendor.findOne({ email: req.body.email });
      if (existingVendor) {
        return res.status(400).json({
          success: false,
          message: 'Vendor with this email already exists'
        });
      }
    }
    
    const updatedVendor = await Vendor.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    
    res.json({
      success: true,
      message: 'Vendor updated successfully',
      data: updatedVendor
    });
  } catch (error) {
    console.error('Update vendor error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update vendor',
      error: error.message
    });
  }
};

// @desc    Delete vendor
// @route   DELETE /api/vendors/:id
// @access  Private (Admin)
exports.deleteVendor = async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.params.id);
    
    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: 'Vendor not found'
      });
    }
    
    // Check if vendor has associated products
    const productsCount = await Product.countDocuments({ vendor: vendor._id });
    if (productsCount > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete vendor. ${productsCount} product(s) are associated with this vendor. Please reassign or delete those products first.`
      });
    }
    
    await vendor.deleteOne();
    
    res.json({
      success: true,
      message: 'Vendor deleted successfully'
    });
  } catch (error) {
    console.error('Delete vendor error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete vendor',
      error: error.message
    });
  }
};

// @desc    Get vendor statistics
// @route   GET /api/vendors/stats
// @access  Private (Admin)
exports.getVendorStats = async (req, res) => {
  try {
    const totalVendors = await Vendor.countDocuments();
    const activeVendors = await Vendor.countDocuments({ status: 'Active' });
    const inactiveVendors = await Vendor.countDocuments({ status: 'Inactive' });
    
    // Get total products supplied by all vendors
    const vendors = await Vendor.find();
    let totalProductsSupplied = 0;
    
    for (const vendor of vendors) {
      const count = await Product.countDocuments({ vendor: vendor._id });
      totalProductsSupplied += count;
    }
    
    res.json({
      success: true,
      data: {
        totalVendors,
        activeVendors,
        inactiveVendors,
        totalProductsSupplied
      }
    });
  } catch (error) {
    console.error('Get vendor stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch vendor statistics',
      error: error.message
    });
  }
};
