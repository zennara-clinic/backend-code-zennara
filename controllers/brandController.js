const Brand = require('../models/Brand');
const Product = require('../models/Product');

// @desc    Get all brands
// @route   GET /api/admin/brands
// @access  Private (Admin)
exports.getAllBrands = async (req, res) => {
  try {
    const { search, isActive } = req.query;
    
    let query = {};
    
    // Search filter
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } }
      ];
    }
    
    // Active filter
    if (isActive !== undefined) {
      query.isActive = isActive === 'true';
    }
    
    const brands = await Brand.find(query).sort({ name: 1 });
    
    // Update products count for each brand
    for (let brand of brands) {
      const count = await Product.countDocuments({ OrgName: brand.name });
      if (brand.productsCount !== count) {
        brand.productsCount = count;
        await brand.save();
      }
    }
    
    res.json({
      success: true,
      data: brands
    });
  } catch (error) {
    console.error('Error fetching brands:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch brands',
      error: error.message
    });
  }
};

// @desc    Get single brand
// @route   GET /api/admin/brands/:id
// @access  Private (Admin)
exports.getBrandById = async (req, res) => {
  try {
    const brand = await Brand.findById(req.params.id);
    
    if (!brand) {
      return res.status(404).json({
        success: false,
        message: 'Brand not found'
      });
    }
    
    // Update products count
    const count = await Product.countDocuments({ OrgName: brand.name });
    brand.productsCount = count;
    await brand.save();
    
    res.json({
      success: true,
      data: brand
    });
  } catch (error) {
    console.error('Error fetching brand:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch brand',
      error: error.message
    });
  }
};

// @desc    Create new brand
// @route   POST /api/admin/brands
// @access  Private (Admin)
exports.createBrand = async (req, res) => {
  try {
    const { name, description, logo, website, isActive } = req.body;
    
    // Check if brand already exists
    const existingBrand = await Brand.findOne({ name });
    if (existingBrand) {
      return res.status(400).json({
        success: false,
        message: 'Brand with this name already exists'
      });
    }
    
    const brand = await Brand.create({
      name,
      description,
      logo,
      website,
      isActive
    });
    
    res.status(201).json({
      success: true,
      message: 'Brand created successfully',
      data: brand
    });
  } catch (error) {
    console.error('Error creating brand:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create brand',
      error: error.message
    });
  }
};

// @desc    Update brand
// @route   PUT /api/admin/brands/:id
// @access  Private (Admin)
exports.updateBrand = async (req, res) => {
  try {
    const { name, description, logo, website, isActive } = req.body;
    
    const brand = await Brand.findById(req.params.id);
    
    if (!brand) {
      return res.status(404).json({
        success: false,
        message: 'Brand not found'
      });
    }
    
    // If name is being changed, check for duplicates
    if (name && name !== brand.name) {
      const existingBrand = await Brand.findOne({ name });
      if (existingBrand) {
        return res.status(400).json({
          success: false,
          message: 'Brand with this name already exists'
        });
      }
      
      // Update all products with old brand name
      await Product.updateMany(
        { OrgName: brand.name },
        { OrgName: name }
      );
    }
    
    brand.name = name || brand.name;
    brand.description = description !== undefined ? description : brand.description;
    brand.logo = logo !== undefined ? logo : brand.logo;
    brand.website = website !== undefined ? website : brand.website;
    brand.isActive = isActive !== undefined ? isActive : brand.isActive;
    
    await brand.save();
    
    res.json({
      success: true,
      message: 'Brand updated successfully',
      data: brand
    });
  } catch (error) {
    console.error('Error updating brand:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update brand',
      error: error.message
    });
  }
};

// @desc    Delete brand
// @route   DELETE /api/admin/brands/:id
// @access  Private (Admin)
exports.deleteBrand = async (req, res) => {
  try {
    const brand = await Brand.findById(req.params.id);
    
    if (!brand) {
      return res.status(404).json({
        success: false,
        message: 'Brand not found'
      });
    }
    
    // Check if brand has products
    const productsCount = await Product.countDocuments({ OrgName: brand.name });
    if (productsCount > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete brand. ${productsCount} product(s) are using this brand.`
      });
    }
    
    await brand.deleteOne();
    
    res.json({
      success: true,
      message: 'Brand deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting brand:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete brand',
      error: error.message
    });
  }
};

// @desc    Get brand statistics
// @route   GET /api/admin/brands/statistics
// @access  Private (Admin)
exports.getBrandStatistics = async (req, res) => {
  try {
    const totalBrands = await Brand.countDocuments();
    const activeBrands = await Brand.countDocuments({ isActive: true });
    const inactiveBrands = await Brand.countDocuments({ isActive: false });
    
    // Get brands with most products
    const brands = await Brand.find().sort({ productsCount: -1 }).limit(5);
    
    res.json({
      success: true,
      data: {
        total: totalBrands,
        active: activeBrands,
        inactive: inactiveBrands,
        topBrands: brands
      }
    });
  } catch (error) {
    console.error('Error fetching brand statistics:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch brand statistics',
      error: error.message
    });
  }
};
