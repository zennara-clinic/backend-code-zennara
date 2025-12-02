const Consultation = require('../models/Consultation');
const Booking = require('../models/Booking');
const Category = require('../models/Category');
const mongoose = require('mongoose');
const NotificationHelper = require('../utils/notificationHelper');

// Helper function to update category consultation count
const updateCategoryCount = async (categoryName) => {
  try {
    const count = await Consultation.countDocuments({ 
      category: categoryName,
      isActive: true 
    });
    
    await Category.findOneAndUpdate(
      { name: categoryName },
      { consultationCount: count },
      { upsert: false }
    );
    
    console.log(`📊 Updated category "${categoryName}" count to ${count}`);
  } catch (error) {
    console.error(`❌ Error updating category count for "${categoryName}":`, error);
  }
};

// @desc    Create new consultation service
// @route   POST /api/consultations
// @access  Private (Admin only)
exports.createConsultation = async (req, res) => {
  try {
    const {
      name,
      category,
      summary,
      about,
      key_benefits,
      ideal_for,
      price,
      cta_label,
      tags,
      faqs,
      pre_care,
      post_care,
      image,
      rating,
      showPriceInApp,
      isPopular
    } = req.body;

    // Validate required fields
    if (!name || !category || !summary || !about || !price || !image) {
      return res.status(400).json({
        success: false,
        message: 'Please provide all required fields'
      });
    }

    // Generate unique ID and slug
    const id = `consult-${Date.now()}`;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

    const consultation = await Consultation.create({
      id,
      slug,
      name,
      category,
      summary,
      about,
      key_benefits,
      ideal_for,
      price,
      cta_label,
      tags,
      faqs,
      pre_care,
      post_care,
      image,
      rating,
      showPriceInApp: showPriceInApp !== undefined ? showPriceInApp : false,
      isPopular: isPopular !== undefined ? isPopular : false
    });

    // Update category count
    await updateCategoryCount(category);

    // Create notification for new consultation
    try {
      await NotificationHelper.consultationCreated({
        _id: consultation._id,
        name: consultation.name,
        price: consultation.price
      });
      console.log('🔔 Consultation creation notification created');
    } catch (notifError) {
      console.error('⚠️ Failed to create notification:', notifError.message);
    }

    res.status(201).json({
      success: true,
      message: 'Consultation service created successfully',
      data: consultation
    });
  } catch (error) {
    console.error('❌ Create consultation error:', error);
    
    // Handle duplicate key error
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'A consultation with this name already exists'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to create consultation service'
    });
  }
};

// @desc    Update consultation service
// @route   PUT /api/consultations/:id
// @access  Private (Admin only)
exports.updateConsultation = async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = { ...req.body };

    // Get old consultation to track category changes
    const oldConsultation = await Consultation.findOne({
      $or: [{ _id: mongoose.Types.ObjectId.isValid(id) ? id : null }, { id: id }, { slug: id }]
    });

    // Remove fields that are no longer in the schema
    delete updateData.duration_minutes;
    delete updateData.reviews;

    // If name is being updated, update slug too
    if (updateData.name) {
      updateData.slug = updateData.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    }

    const consultation = await Consultation.findOneAndUpdate(
      { $or: [{ _id: mongoose.Types.ObjectId.isValid(id) ? id : null }, { id: id }, { slug: id }] },
      updateData,
      { new: true, runValidators: true }
    );

    if (!consultation) {
      return res.status(404).json({
        success: false,
        message: 'Consultation service not found'
      });
    }

    // Update category counts (both old and new if category changed)
    if (oldConsultation && updateData.category && oldConsultation.category !== updateData.category) {
      await updateCategoryCount(oldConsultation.category); // Update old category
      await updateCategoryCount(updateData.category); // Update new category
    } else if (consultation) {
      await updateCategoryCount(consultation.category); // Update current category
    }

    // Create notification for consultation update
    try {
      await NotificationHelper.consultationUpdated({
        _id: consultation._id,
        name: consultation.name
      });
      console.log('🔔 Consultation update notification created');
    } catch (notifError) {
      console.error('⚠️ Failed to create notification:', notifError.message);
    }

    res.status(200).json({
      success: true,
      message: 'Consultation service updated successfully',
      data: consultation
    });
  } catch (error) {
    console.error('❌ Update consultation error:', error);
    console.error('❌ Error details:', error.message);
    if (error.name === 'ValidationError') {
      console.error('❌ Validation errors:', error.errors);
    }
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to update consultation service',
      errors: error.errors || null
    });
  }
};

// @desc    Delete consultation service
// @route   DELETE /api/consultations/:id
// @access  Private (Admin only)
exports.deleteConsultation = async (req, res) => {
  try {
    const { id } = req.params;

    const consultation = await Consultation.findOneAndDelete({
      $or: [{ _id: mongoose.Types.ObjectId.isValid(id) ? id : null }, { id: id }, { slug: id }]
    });

    if (!consultation) {
      return res.status(404).json({
        success: false,
        message: 'Consultation service not found'
      });
    }

    // Update category count after deletion
    await updateCategoryCount(consultation.category);

    res.status(200).json({
      success: true,
      message: 'Consultation service deleted successfully',
      data: consultation
    });
  } catch (error) {
    console.error('❌ Delete consultation error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete consultation service'
    });
  }
};

// @desc    Toggle consultation active status
// @route   PATCH /api/consultations/:id/toggle
// @access  Private (Admin only)
exports.toggleConsultationStatus = async (req, res) => {
  try {
    const { id } = req.params;

    const consultation = await Consultation.findOne({
      $or: [{ _id: mongoose.Types.ObjectId.isValid(id) ? id : null }, { id: id }, { slug: id }]
    });

    if (!consultation) {
      return res.status(404).json({
        success: false,
        message: 'Consultation service not found'
      });
    }

    consultation.isActive = !consultation.isActive;
    await consultation.save();

    // Update category count since active status changed
    await updateCategoryCount(consultation.category);

    res.status(200).json({
      success: true,
      message: `Consultation service ${consultation.isActive ? 'activated' : 'deactivated'} successfully`,
      data: consultation
    });
  } catch (error) {
    console.error('❌ Toggle consultation status error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to toggle consultation status'
    });
  }
};

// @desc    Get consultation statistics
// @route   GET /api/consultations/stats/overview
// @access  Private (Admin only)
exports.getConsultationStats = async (req, res) => {
  try {
    const totalServices = await Consultation.countDocuments();
    const activeServices = await Consultation.countDocuments({ isActive: true });
    const inactiveServices = await Consultation.countDocuments({ isActive: false });
    
    // Get average rating (only from consultations with ratings)
    const ratingAgg = await Consultation.aggregate([
      { $match: { rating: { $ne: null } } },
      { $group: { _id: null, avgRating: { $avg: '$rating' } } }
    ]);
    const avgRating = ratingAgg.length > 0 && ratingAgg[0].avgRating ? ratingAgg[0].avgRating.toFixed(1) : 0;

    // Get total confirmed bookings (only Confirmed status)
    const totalBookings = await Booking.countDocuments({ status: 'Confirmed' });
    
    // Get booking statistics by status
    const completedBookings = await Booking.countDocuments({ status: 'Completed' });
    const confirmedBookings = await Booking.countDocuments({ status: 'Confirmed' });
    const awaitingBookings = await Booking.countDocuments({ status: 'Awaiting Confirmation' });
    const cancelledBookings = await Booking.countDocuments({ status: 'Cancelled' });

    // Get popular services count (services marked as popular)
    const featuredServices = await Consultation.countDocuments({ isPopular: true, isActive: true });

    // Get services added this month
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const newThisMonth = await Consultation.countDocuments({
      createdAt: { $gte: startOfMonth }
    });

    // Get category breakdown (all consultations)
    const categoryBreakdown = await Consultation.aggregate([
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    res.status(200).json({
      success: true,
      data: {
        totalServices,
        activeServices,
        inactiveServices,
        featuredServices,
        avgRating: parseFloat(avgRating),
        totalBookings,
        bookingBreakdown: {
          completed: completedBookings,
          confirmed: confirmedBookings,
          awaiting: awaitingBookings,
          cancelled: cancelledBookings
        },
        newThisMonth,
        categoryBreakdown
      }
    });
  } catch (error) {
    console.error('❌ Get consultation stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch consultation statistics'
    });
  }
};

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
      sort,
      isPopular
    } = req.query;

    console.log('📞 getAllConsultations called with params:', {
      category,
      search,
      isPopular,
      isPopularType: typeof isPopular
    });

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

    // Filter by popular
    if (isPopular === 'true') {
      console.log('✅ Filtering for popular consultations');
      query.isPopular = true;
    } else {
      console.log('⚠️ isPopular filter NOT applied. Value:', isPopular);
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

    console.log('🔍 Final query:', query);
    console.log('📊 Sort option:', sortOption);

    const consultations = await Consultation.find(query)
      .sort(sortOption)
      .select('-__v');

    console.log('📦 Found consultations:', {
      count: consultations.length,
      names: consultations.slice(0, 6).map(c => c.name)
    });

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
    // Try to get from Category model first
    let categories = await Category.find({ isActive: true })
      .select('name slug consultationCount')
      .sort({ name: 1 });
    
    // If no categories in Category model, fallback to distinct from consultations
    if (!categories || categories.length === 0) {
      const distinctCategories = await Consultation.distinct('category');
      // Convert to name array for backward compatibility
      categories = distinctCategories;
    } else {
      // Extract just the names for backward compatibility
      categories = categories.map(cat => cat.name);
    }

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

// @desc    Create new category
// @route   POST /api/consultations/categories
// @access  Private (Admin only)
exports.createCategory = async (req, res) => {
  try {
    const { name, description } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Category name is required'
      });
    }

    // Check if category already exists (case-insensitive)
    const existingCategory = await Category.findOne({ 
      name: { $regex: new RegExp(`^${name.trim()}$`, 'i') } 
    });

    if (existingCategory) {
      return res.status(400).json({
        success: false,
        message: 'Category already exists'
      });
    }

    // Create new category
    const category = await Category.create({
      name: name.trim(),
      description: description || ''
    });

    res.status(201).json({
      success: true,
      message: 'Category created successfully',
      data: category
    });
  } catch (error) {
    console.error('❌ Create category error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create category'
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
