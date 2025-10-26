const Product = require('../models/Product');

// @desc    Get all products
// @route   GET /api/products
// @access  Public
exports.getAllProducts = async (req, res) => {
  try {
    const { formulation, search, minPrice, maxPrice, sort, isPopular } = req.query;
    
    // Build query
    const query = { isActive: true };
    
    if (formulation && formulation !== 'All') {
      query.formulation = formulation;
    }
    
    if (search) {
      query.$text = { $search: search };
    }
    
    if (minPrice || maxPrice) {
      query.price = {};
      if (minPrice) query.price.$gte = Number(minPrice);
      if (maxPrice) query.price.$lte = Number(maxPrice);
    }
    
    if (isPopular === 'true') {
      query.isPopular = true;
    }
    
    // Build sort
    let sortOption = {};
    switch (sort) {
      case 'price_asc':
        sortOption = { price: 1 };
        break;
      case 'price_desc':
        sortOption = { price: -1 };
        break;
      case 'rating':
        sortOption = { rating: -1 };
        break;
      case 'popular':
        sortOption = { reviews: -1 };
        break;
      default:
        sortOption = { createdAt: -1 };
    }
    
    const products = await Product.find(query).sort(sortOption);
    
    res.json({
      success: true,
      data: products
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

// @desc    Get single product by ID
// @route   GET /api/products/:id
// @access  Public
exports.getProductById = async (req, res) => {
  try {
    const { id } = req.params;
    
    // Validate MongoDB ObjectId
    if (!id.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid product ID format'
      });
    }
    
    const product = await Product.findById(id);
    
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

// @desc    Get products by formulation
// @route   GET /api/products/formulation/:formulation
// @access  Public
exports.getProductsByFormulation = async (req, res) => {
  try {
    const { formulation } = req.params;
    const { limit } = req.query;
    
    const query = { formulation, isActive: true };
    
    let productsQuery = Product.find(query).sort({ createdAt: -1 });
    
    if (limit) {
      productsQuery = productsQuery.limit(parseInt(limit));
    }
    
    const products = await productsQuery;
    
    res.json({
      success: true,
      data: products,
      count: products.length
    });
  } catch (error) {
    console.error('Get products by formulation error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch products',
      error: error.message
    });
  }
};

// @desc    Search products
// @route   GET /api/products/search/:query
// @access  Public
exports.searchProducts = async (req, res) => {
  try {
    const { query } = req.params;
    const { limit } = req.query;
    
    const searchQuery = {
      isActive: true,
      $or: [
        { name: { $regex: query, $options: 'i' } },
        { description: { $regex: query, $options: 'i' } },
        { OrgName: { $regex: query, $options: 'i' } },
        { formulation: { $regex: query, $options: 'i' } }
      ]
    };
    
    let productsQuery = Product.find(searchQuery).sort({ rating: -1, reviews: -1 });
    
    if (limit) {
      productsQuery = productsQuery.limit(parseInt(limit));
    }
    
    const products = await productsQuery;
    
    res.json({
      success: true,
      data: products,
      count: products.length
    });
  } catch (error) {
    console.error('Search products error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to search products',
      error: error.message
    });
  }
};

// @desc    Get all formulations
// @route   GET /api/products/formulations/list
// @access  Public
exports.getFormulations = async (req, res) => {
  try {
    const formulations = await Product.distinct('formulation', { isActive: true });
    
    res.json({
      success: true,
      data: formulations
    });
  } catch (error) {
    console.error('Get formulations error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch formulations',
      error: error.message
    });
  }
};

// @desc    Check stock availability
// @route   POST /api/products/check-stock
// @access  Public
exports.checkStock = async (req, res) => {
  try {
    const { items } = req.body; // Array of { productId, quantity }
    
    const stockStatus = [];
    let allAvailable = true;
    
    for (const item of items) {
      const product = await Product.findById(item.productId);
      
      if (!product) {
        stockStatus.push({
          productId: item.productId,
          available: false,
          reason: 'Product not found'
        });
        allAvailable = false;
        continue;
      }
      
      if (!product.isActive) {
        stockStatus.push({
          productId: item.productId,
          productName: product.name,
          available: false,
          reason: 'Product is not available'
        });
        allAvailable = false;
        continue;
      }
      
      if (product.stock < item.quantity) {
        stockStatus.push({
          productId: item.productId,
          productName: product.name,
          available: false,
          reason: 'Insufficient stock',
          availableStock: product.stock,
          requestedQuantity: item.quantity
        });
        allAvailable = false;
        continue;
      }
      
      stockStatus.push({
        productId: item.productId,
        productName: product.name,
        available: true,
        availableStock: product.stock
      });
    }
    
    res.json({
      success: true,
      allAvailable,
      stockStatus
    });
  } catch (error) {
    console.error('Check stock error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check stock',
      error: error.message
    });
  }
};
