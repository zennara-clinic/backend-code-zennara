const Consultation = require('../models/Consultation');

// @desc    Get all consultations
// @route   GET /api/consultations
// @access  Public
exports.getAllConsultations = async (req, res) => {
  try {
    const { 
      category, 
      search, 
      minPrice, 
      maxPrice,
      tags,
      sort 
    } = req.query;

    // Build query
    let query = { isActive: true };

    // Filter by category
    if (category && category !== 'All') {
      query.category = category;
    }

    // Search by name, summary, or about
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { summary: { $regex: search, $options: 'i' } },
        { about: { $regex: search, $options: 'i' } },
        { tags: { $regex: search, $options: 'i' } }
      ];
    }

    // Filter by price range
    if (minPrice || maxPrice) {
      query.price = {};
      if (minPrice) query.price.$gte = Number(minPrice);
      if (maxPrice) query.price.$lte = Number(maxPrice);
    }

    // Filter by tags
    if (tags) {
      const tagArray = tags.split(',').map(tag => tag.trim());
      query.tags = { $in: tagArray };
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
      case 'name':
        sortOption = { name: 1 };
        break;
      default:
        sortOption = { createdAt: -1 };
    }

    const consultations = await Consultation.find(query)
      .sort(sortOption)
      .select('-__v');

    res.status(200).json({
      success: true,
      count: consultations.length,
      data: consultations
    });
  } catch (error) {
    console.error('❌ Get consultations error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch consultations'
    });
  }
};

// @desc    Get single consultation by ID or slug
// @route   GET /api/consultations/:identifier
// @access  Public
exports.getConsultation = async (req, res) => {
  try {
    const { identifier } = req.params;

    // Build query - check if identifier is a valid MongoDB ObjectId
    const query = {
      isActive: true
    };

    // Check if it's a valid MongoDB ObjectId (24 hex characters)
    const isValidObjectId = /^[0-9a-fA-F]{24}$/.test(identifier);
    
    if (isValidObjectId) {
      query.$or = [
        { _id: identifier },
        { id: identifier },
        { slug: identifier }
      ];
    } else {
      // Not a valid ObjectId, only search by id and slug
      query.$or = [
        { id: identifier },
        { slug: identifier }
      ];
    }

    const consultation = await Consultation.findOne(query).select('-__v');

    if (!consultation) {
      return res.status(404).json({
        success: false,
        message: 'Consultation not found'
      });
    }

    res.status(200).json({
      success: true,
      data: consultation
    });
  } catch (error) {
    console.error('❌ Get consultation error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch consultation'
    });
  }
};

// @desc    Get consultations by category
// @route   GET /api/consultations/category/:category
// @access  Public
exports.getConsultationsByCategory = async (req, res) => {
  try {
    const { category } = req.params;
    const { limit = 10 } = req.query;

    const consultations = await Consultation.find({
      category,
      isActive: true
    })
      .sort({ rating: -1, reviews: -1 })
      .limit(Number(limit))
      .select('-__v');

    res.status(200).json({
      success: true,
      count: consultations.length,
      data: consultations
    });
  } catch (error) {
    console.error('❌ Get consultations by category error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch consultations'
    });
  }
};

// @desc    Get featured/popular consultations
// @route   GET /api/consultations/featured
// @access  Public
exports.getFeaturedConsultations = async (req, res) => {
  try {
    const { limit = 6 } = req.query;

    const consultations = await Consultation.find({ isActive: true })
      .sort({ rating: -1, reviews: -1 })
      .limit(Number(limit))
      .select('-__v');

    res.status(200).json({
      success: true,
      count: consultations.length,
      data: consultations
    });
  } catch (error) {
    console.error('❌ Get featured consultations error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch featured consultations'
    });
  }
};

// @desc    Get all categories
// @route   GET /api/consultations/categories/list
// @access  Public
exports.getCategories = async (req, res) => {
  try {
    const categories = await Consultation.distinct('category', { isActive: true });

    res.status(200).json({
      success: true,
      count: categories.length,
      data: categories
    });
  } catch (error) {
    console.error('❌ Get categories error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch categories'
    });
  }
};

// @desc    Search consultations
// @route   GET /api/consultations/search/:query
// @access  Public
exports.searchConsultations = async (req, res) => {
  try {
    const { query } = req.params;
    const { limit = 20 } = req.query;

    const consultations = await Consultation.find({
      $text: { $search: query },
      isActive: true
    })
      .sort({ score: { $meta: 'textScore' } })
      .limit(Number(limit))
      .select('-__v');

    res.status(200).json({
      success: true,
      count: consultations.length,
      data: consultations
    });
  } catch (error) {
    console.error('❌ Search consultations error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to search consultations'
    });
  }
};
