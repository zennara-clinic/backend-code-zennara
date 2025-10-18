const Product = require('../models/Product');
const cloudinary = require('../config/cloudinary');

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
        { OrgName: { $regex: search, $options: 'i' } }
      ];
    }
    
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
    if (!name || !description || !formulation || !OrgName || !price || !image) {
      return res.status(400).json({
        success: false,
        message: 'Please provide all required fields'
      });
    }

    // Create product
    const product = await Product.create({
      name,
      description,
      formulation,
      OrgName,
      code: code || undefined, // Save code if provided
      price,
      gstPercentage: gstPercentage || 18,
      image,
      stock: stock || 0,
      isActive: isActive !== undefined ? isActive : true,
      isPopular: isPopular || false
    });

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

    // Update fields
    if (name) product.name = name;
    if (description) product.description = description;
    if (formulation) product.formulation = formulation;
    if (OrgName) product.OrgName = OrgName;
    if (code !== undefined) {
      product.code = code;
      console.log('Setting product code to:', code);
    }
    if (price !== undefined) product.price = price;
    if (gstPercentage !== undefined) product.gstPercentage = gstPercentage;
    if (image) product.image = image;
    if (stock !== undefined) product.stock = stock;
    if (isActive !== undefined) product.isActive = isActive;
    if (isPopular !== undefined) product.isPopular = isPopular;

    await product.save();
    console.log('Product saved with code:', product.code);

    res.json({
      success: true,
      message: 'Product updated successfully',
      data: product
    });
  } catch (error) {
    console.error('Update product error:', error);
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

    // Delete image from Cloudinary if it's a Cloudinary URL
    if (product.image && product.image.includes('cloudinary.com')) {
      try {
        const publicId = product.image.split('/').pop().split('.')[0];
        await cloudinary.uploader.destroy(`zennara-products/${publicId}`);
      } catch (cloudError) {
        console.error('Cloudinary delete error:', cloudError);
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
