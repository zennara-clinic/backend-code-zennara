const Consultation = require('../models/Consultation');

/**
 * What a customer is allowed to see.
 *
 * The service master holds everything the clinic bills for — ~800 rows,
 * including staff lines, per-doctor variants and one-off billing entries. The
 * app must show only what the desk has deliberately published to the
 * catalogue, and never an archived row (which exists purely so historical
 * bookings still resolve to a named treatment).
 */
const APP_VISIBLE = { isActive: true, inCatalog: true, isArchived: { $ne: true } };
/** Everything the panel lists: live master data, archived rows excluded. */
const NOT_ARCHIVED = { isArchived: { $ne: true } };

/**
 * The two rows that ARE the consultation flow.
 *
 * A consultation is booked by choosing a dermatologist, not by picking a
 * treatment off the menu, so these must not appear in any treatment listing.
 * They cannot simply be unpublished: the app fetches the catalogue and resolves
 * them by slug to price the booking, so they have to stay visible to it while
 * staying out of the browsable menu.
 */
const CONSULTATION_FLOW_SLUGS = ['senior-dermatologist-consultation', 'dermatologist-consultation'];
const NOT_CONSULTATION_FLOW = { slug: { $nin: CONSULTATION_FLOW_SLUGS } };
const { clinicDateKey, clinicDayStart } = require('../utils/bookingTime');
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
      chargeOnlineBooking,
      isPopular,
      type,
      media,
      isActive,
      displayOrder
    } = req.body;

    // Validate required fields. Image is optional (the app shows a placeholder
    // panel) and price may be 0 for enquiry-only treatments.
    if (!name || !category || !summary || !about || price === undefined || price === null || price === '') {
      return res.status(400).json({
        success: false,
        message: 'Please provide name, category, summary, about and price'
      });
    }

    // Generate unique ID and slug; keep the slug unique if the name repeats.
    const id = `consult-${Date.now()}`;
    const baseSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    let slug = baseSlug;
    for (let n = 2; await Consultation.exists({ slug }); n++) slug = `${baseSlug}-${n}`;

    const consultation = await Consultation.create({
      id,
      slug,
      name,
      type,
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
      media,
      rating,
      displayOrder,
      isActive: isActive !== undefined ? isActive : true,
      showPriceInApp: showPriceInApp !== undefined ? showPriceInApp : false,
      chargeOnlineBooking: chargeOnlineBooking !== undefined ? chargeOnlineBooking : true,
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

    // The slug is a permanent deep-link key — a rename must not change it
    // (that broke every existing link and could collide on the unique index).
    delete updateData.slug;
    delete updateData.id;

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

/**
 * Publish a service to the app catalogue, or take it back off.
 *
 * Separate from the active toggle on purpose: "the clinic still performs this"
 * and "a customer can see and buy this" are different decisions, and the second
 * is a storefront change worth recording. Bulk-capable, because publishing a
 * category is otherwise 40 clicks.
 *
 * @route  PATCH /api/consultations/catalog
 * @access Private (Admin only)
 */
exports.setCatalogMembership = async (req, res) => {
  try {
    const { ids, inCatalog } = req.body || {};
    const list = Array.isArray(ids) ? ids.filter(Boolean) : [];
    if (!list.length) {
      return res.status(400).json({ success: false, message: 'Choose at least one service.' });
    }
    if (typeof inCatalog !== 'boolean') {
      return res.status(400).json({ success: false, message: 'Say whether these go in the catalogue or come out of it.' });
    }

    const objectIds = list.filter((v) => mongoose.Types.ObjectId.isValid(v));
    const match = { $or: [{ _id: { $in: objectIds } }, { id: { $in: list } }, { slug: { $in: list } }] };

    // An archived row is history; it must never reappear in the app.
    const targets = await Consultation.find({ ...match, isArchived: { $ne: true } }).select('_id name category');
    if (!targets.length) {
      return res.status(404).json({ success: false, message: 'None of those services were found.' });
    }

    const who = req.admin?.name || req.admin?.email || 'Admin';
    await Consultation.updateMany(
      { _id: { $in: targets.map((t) => t._id) } },
      inCatalog
        ? { $set: { inCatalog: true, catalogAddedAt: new Date(), catalogAddedBy: who, isActive: true } }
        : { $set: { inCatalog: false, catalogAddedAt: null, catalogAddedBy: null } },
    );

    await Promise.all([...new Set(targets.map((t) => t.category))].map((c) => updateCategoryCount(c)));

    return res.json({
      success: true,
      message: inCatalog
        ? `${targets.length} service${targets.length === 1 ? '' : 's'} published to the app`
        : `${targets.length} service${targets.length === 1 ? '' : 's'} removed from the app`,
      data: { count: targets.length },
    });
  } catch (error) {
    console.error('Set catalog membership error:', error);
    return res.status(500).json({ success: false, message: 'Could not update the catalogue' });
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
    const activeServices = await Consultation.countDocuments({ isActive: true, ...NOT_ARCHIVED });
    const inactiveServices = await Consultation.countDocuments({ isActive: false, ...NOT_ARCHIVED });
    
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
    const featuredServices = await Consultation.countDocuments({ isPopular: true, ...APP_VISIBLE });

    // Get services added this month
    // The clinic's month, not the server's timezone.
    const startOfMonth = clinicDayStart(`${clinicDateKey(new Date()).slice(0, 8)}01`);
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
      type,
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

    // Build query. Staff can ask for the inactive ones too.
    const wantsInactive = req.admin && (req.query.includeInactive === 'true' || req.query.isActive === 'false' || req.query.isActive === 'all');
    let query = req.admin
      ? (wantsInactive
        ? (req.query.isActive === 'false' ? { ...NOT_ARCHIVED, isActive: false } : { ...NOT_ARCHIVED })
        : { ...NOT_ARCHIVED, isActive: true })
      : { ...APP_VISIBLE };
    // Staff can ask for just the published subset, or just the unpublished master.
    if (req.admin && req.query.inCatalog === 'true') query.inCatalog = true;
    if (req.admin && req.query.inCatalog === 'false') query.inCatalog = { $ne: true };
    if (req.admin && req.query.archived === 'true') { delete query.isArchived; query.isArchived = true; }
    // Staff browse the treatment menu; the consultation tiers are priced on the
    // Dermatologists page, not here. ?includeConsultationTiers=true opts in.
    if (req.admin && req.query.includeConsultationTiers !== 'true') Object.assign(query, NOT_CONSULTATION_FLOW);
    if (req.query.subCategory && req.query.subCategory !== 'All') query.subCategory = req.query.subCategory;

    // Level 1 of the taxonomy — Skin, Hair, Skin & Hair, Wellness, …
    if (type && type !== 'All') {
      query.type = type;
    }

    // Level 2 — the treatment category
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
        sortOption = { displayOrder: 1, createdAt: -1 };
    }

    console.log('🔍 Final query:', query);
    console.log('📊 Sort option:', sortOption);

    let find = Consultation.find(query).sort(sortOption).select('-__v');
    if (req.query.limit) find = find.limit(Math.min(1000, parseInt(req.query.limit, 10) || 50));
    const consultations = await find;

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

    // Build query - check if identifier is a valid MongoDB ObjectId.
    // Staff can open a deactivated service; the app cannot.
    const query = req.admin ? {} : { ...APP_VISIBLE };

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

    const consultations = await Consultation.find({ category, ...APP_VISIBLE })
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

    const consultations = await Consultation.find({ ...APP_VISIBLE })
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
    /*
     * The taxonomy cascades: picking "Skin & Hair" must narrow the category row
     * to the categories inside it. Without `type` the app listed all 13 under
     * every tab, so choosing a type appeared to do nothing and picking a
     * category from another type emptied the screen.
     *
     * `subCategory` narrows one level further, for a panel that has already
     * picked a category.
     */
    const { type, category } = req.query;
    const filter = { isActive: true };
    if (type && type !== 'All') filter.type = type;

    // Sub-categories (the treatment groups) inside a category, when asked for.
    if (String(req.query.level || '') === 'subCategory') {
      const q = { isArchived: { $ne: true }, ...(req.admin ? {} : APP_VISIBLE) };
      if (type && type !== 'All') q.type = type;
      if (category && category !== 'All') q.category = category;
      const subs = (await Consultation.distinct('subCategory', q)).filter(Boolean).sort();
      return res.status(200).json({ success: true, count: subs.length, data: subs });
    }

    // Try to get from Category model first
    let categories = await Category.find(filter)
      .select('name slug consultationCount type')
      .sort({ name: 1 });
    
    // If no categories in Category model, fallback to distinct from consultations
    if (!categories || categories.length === 0) {
      const q = { isArchived: { $ne: true }, ...(req.admin ? {} : APP_VISIBLE) };
      if (type && type !== 'All') q.type = type;
      const distinctCategories = await Consultation.distinct('category', q);
      // Convert to name array for backward compatibility
      categories = distinctCategories.filter(Boolean).sort();
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
      ...(req.admin ? NOT_ARCHIVED : APP_VISIBLE),
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


// @desc    Reorder services (bulk displayOrder)
// @route   PATCH /api/consultations/reorder   body: { order: [{ id, displayOrder }] }
// @access  Private (Admin)
exports.reorderConsultations = async (req, res) => {
  try {
    const order = Array.isArray(req.body.order) ? req.body.order : [];
    if (!order.length) return res.status(400).json({ success: false, message: 'order[] is required' });
    await Consultation.bulkWrite(order.map((o, i) => ({
      updateOne: {
        filter: mongoose.Types.ObjectId.isValid(o.id) ? { _id: o.id } : { $or: [{ id: o.id }, { slug: o.id }] },
        update: { $set: { displayOrder: typeof o.displayOrder === 'number' ? o.displayOrder : i } },
      },
    })));
    return res.status(200).json({ success: true, message: 'Order saved' });
  } catch (error) {
    console.error('Reorder consultations error:', error);
    return res.status(500).json({ success: false, message: 'Failed to reorder', error: error.message });
  }
};
