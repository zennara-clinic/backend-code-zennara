const ServiceType = require('../models/ServiceType');
const Category = require('../models/Category');
const Consultation = require('../models/Consultation');
const { slugify } = require('../data/serviceTaxonomy');

/**
 * Level 1 of the service taxonomy.
 *
 * Reads are public — the app's treatment page browses by type before category.
 * Writes are admin-only and mounted that way on the route.
 */

// @desc    List service types, optionally with their categories nested
// @route   GET /api/service-types
// @access  Public
exports.getTypes = async (req, res) => {
  try {
    const { includeInactive, withCategories } = req.query;

    const filter = includeInactive === 'true' ? {} : { isActive: true };
    const types = await ServiceType.find(filter)
      .sort({ displayOrder: 1, name: 1 })
      .lean();

    if (withCategories === 'true') {
      const categories = await Category.find({ isActive: true })
        .sort({ displayOrder: 1, name: 1 })
        .lean();
      for (const t of types) {
        t.categories = categories.filter((c) => c.type === t.name);
      }
    }

    return res.status(200).json({ success: true, count: types.length, data: types });
  } catch (error) {
    console.error('Get service types error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch service types',
      error: error.message,
    });
  }
};

/**
 * The whole tree in one call: types → categories → sub-categories.
 *
 * The app's treatment page needs all three levels at once; fetching them
 * separately meant three round trips and a flash of half-built filters.
 */
// @route   GET /api/service-types/tree
// @access  Public
exports.getTree = async (req, res) => {
  try {
    const [types, categories, treatments] = await Promise.all([
      ServiceType.find({ isActive: true }).sort({ displayOrder: 1, name: 1 }).lean(),
      Category.find({ isActive: true }).sort({ displayOrder: 1, name: 1 }).lean(),
      Consultation.find({ isActive: true })
        .select('name slug type category price image summary rating reviews isPopular showPriceInApp')
        .lean(),
    ]);

    const tree = types.map((t) => ({
      _id: t._id,
      name: t.name,
      slug: t.slug,
      displayOrder: t.displayOrder,
      categories: categories
        .filter((c) => c.type === t.name)
        .map((c) => ({
          _id: c._id,
          name: c.name,
          slug: c.slug,
          displayOrder: c.displayOrder,
          // A sub-category belongs to its category; its own type can differ
          // from the category's (Laser Hair Removal is Hair inside a Skin
          // category), so the count here is of the category's children.
          subCategories: treatments.filter((s) => s.category === c.name),
        })),
      treatmentCount: treatments.filter((s) => s.type === t.name).length,
    }));

    return res.status(200).json({
      success: true,
      data: {
        types: tree,
        totals: {
          types: types.length,
          categories: categories.length,
          subCategories: treatments.length,
        },
      },
    });
  } catch (error) {
    console.error('Get taxonomy tree error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch the service taxonomy',
      error: error.message,
    });
  }
};

// @desc    Create a service type
// @route   POST /api/service-types
// @access  Admin
exports.createType = async (req, res) => {
  try {
    const { name, description, displayOrder } = req.body;
    if (!name?.trim()) {
      return res.status(400).json({ success: false, message: 'A type name is required' });
    }

    const slug = slugify(name);
    const clash = await ServiceType.findOne({ $or: [{ slug }, { name: name.trim() }] });
    if (clash) {
      return res.status(400).json({ success: false, message: 'A type with that name already exists' });
    }

    const type = await ServiceType.create({
      name: name.trim(),
      slug,
      description: description ?? '',
      displayOrder: Number(displayOrder) || 0,
    });

    return res.status(201).json({ success: true, message: 'Service type created', data: type });
  } catch (error) {
    console.error('Create service type error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create the service type',
      error: error.message,
    });
  }
};

// @desc    Update a service type
// @route   PUT /api/service-types/:id
// @access  Admin
exports.updateType = async (req, res) => {
  try {
    const { name, description, displayOrder, isActive } = req.body;
    const type = await ServiceType.findById(req.params.id);
    if (!type) {
      return res.status(404).json({ success: false, message: 'Service type not found' });
    }

    const previousName = type.name;
    if (name !== undefined) type.name = name.trim();
    if (description !== undefined) type.description = description;
    if (displayOrder !== undefined) type.displayOrder = Number(displayOrder) || 0;
    if (isActive !== undefined) type.isActive = isActive;
    await type.save();

    // Categories and treatments reference the type by name, so a rename has to
    // travel down the tree or they would point at a type that no longer exists.
    let moved = 0;
    if (name !== undefined && type.name !== previousName) {
      const cats = await Category.updateMany({ type: previousName }, { $set: { type: type.name } });
      const subs = await Consultation.updateMany({ type: previousName }, { $set: { type: type.name } });
      moved = (cats.modifiedCount ?? 0) + (subs.modifiedCount ?? 0);
    }

    return res.status(200).json({
      success: true,
      message: moved
        ? `Type updated — ${moved} categories and treatments re-pointed.`
        : 'Type updated',
      data: type,
    });
  } catch (error) {
    console.error('Update service type error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update the service type',
      error: error.message,
    });
  }
};

// @desc    Delete a service type
// @route   DELETE /api/service-types/:id
// @access  Admin
exports.deleteType = async (req, res) => {
  try {
    const type = await ServiceType.findById(req.params.id);
    if (!type) {
      return res.status(404).json({ success: false, message: 'Service type not found' });
    }

    const categories = await Category.countDocuments({ type: type.name });
    if (categories > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete "${type.name}" — ${categories} treatment categor${categories === 1 ? 'y is' : 'ies are'} filed under it. Move them first.`,
      });
    }

    await ServiceType.deleteOne({ _id: type._id });
    return res.status(200).json({ success: true, message: 'Service type deleted' });
  } catch (error) {
    console.error('Delete service type error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete the service type',
      error: error.message,
    });
  }
};

// @desc    Recalculate the counts shown against each type and category
// @route   POST /api/service-types/sync-counts
// @access  Admin
exports.syncCounts = async (req, res) => {
  try {
    const types = await ServiceType.find().lean();
    const categories = await Category.find().lean();

    for (const c of categories) {
      const count = await Consultation.countDocuments({ category: c.name, isActive: true });
      await Category.updateOne({ _id: c._id }, { $set: { consultationCount: count } });
    }
    for (const t of types) {
      await ServiceType.updateOne(
        { _id: t._id },
        {
          $set: {
            categoryCount: categories.filter((c) => c.type === t.name).length,
            treatmentCount: await Consultation.countDocuments({ type: t.name, isActive: true }),
          },
        },
      );
    }

    return res.status(200).json({ success: true, message: 'Counts recalculated' });
  } catch (error) {
    console.error('Sync counts error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to recalculate counts',
      error: error.message,
    });
  }
};
