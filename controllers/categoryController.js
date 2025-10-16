const Category = require('../models/Category');
const Consultation = require('../models/Consultation');

// @desc    Get all categories with statistics
// @route   GET /api/categories
// @access  Public
exports.getAllCategories = async (req, res) => {
  try {
    const categories = await Category.find().sort({ name: 1 });
    
    // Calculate statistics
    const stats = {
      total: categories.length,
      active: categories.filter(cat => cat.isActive).length,
      inactive: categories.filter(cat => !cat.isActive).length,
      totalServices: categories.reduce((sum, cat) => sum + cat.consultationCount, 0)
    };

    res.json({
      success: true,
      data: categories,
      stats
    });
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch categories',
      error: error.message
    });
  }
};

// @desc    Get single category by ID
// @route   GET /api/categories/:id
// @access  Public
exports.getCategoryById = async (req, res) => {
  try {
    const category = await Category.findById(req.params.id);
    
    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    res.json({
      success: true,
      data: category
    });
  } catch (error) {
    console.error('Error fetching category:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch category',
      error: error.message
    });
  }
};

// @desc    Create new category
// @route   POST /api/categories
// @access  Private/Admin
exports.createCategory = async (req, res) => {
  try {
    const { name, description } = req.body;

    // Validation
    if (!name || name.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Category name is required'
      });
    }

    // Check if category already exists
    const existingCategory = await Category.findOne({ 
      name: { $regex: new RegExp(`^${name}$`, 'i') } 
    });

    if (existingCategory) {
      return res.status(400).json({
        success: false,
        message: 'Category with this name already exists'
      });
    }

    // Count consultations with this category
    const consultationCount = await Consultation.countDocuments({ 
      category: name,
      isActive: true 
    });

    // Create new category
    const category = await Category.create({
      name: name.trim(),
      description: description || '',
      consultationCount
    });

    res.status(201).json({
      success: true,
      message: 'Category created successfully',
      data: category
    });
  } catch (error) {
    console.error('Error creating category:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create category',
      error: error.message
    });
  }
};

// @desc    Update category
// @route   PUT /api/categories/:id
// @access  Private/Admin
exports.updateCategory = async (req, res) => {
  try {
    const { name, description, isActive } = req.body;

    const category = await Category.findById(req.params.id);
    
    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    // Check if new name already exists (if name is being changed)
    if (name && name !== category.name) {
      const existingCategory = await Category.findOne({ 
        name: { $regex: new RegExp(`^${name}$`, 'i') },
        _id: { $ne: req.params.id }
      });

      if (existingCategory) {
        return res.status(400).json({
          success: false,
          message: 'Category with this name already exists'
        });
      }
    }

    // Update fields
    if (name) category.name = name.trim();
    if (description !== undefined) category.description = description;
    if (isActive !== undefined) category.isActive = isActive;

    // Update consultation count
    const consultationCount = await Consultation.countDocuments({ 
      category: category.name,
      isActive: true 
    });
    category.consultationCount = consultationCount;

    await category.save();

    res.json({
      success: true,
      message: 'Category updated successfully',
      data: category
    });
  } catch (error) {
    console.error('Error updating category:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update category',
      error: error.message
    });
  }
};

// @desc    Toggle category active status
// @route   PATCH /api/categories/:id/toggle-status
// @access  Private/Admin
exports.toggleCategoryStatus = async (req, res) => {
  try {
    const category = await Category.findById(req.params.id);
    
    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    category.isActive = !category.isActive;
    await category.save();

    res.json({
      success: true,
      message: `Category ${category.isActive ? 'activated' : 'deactivated'} successfully`,
      data: category
    });
  } catch (error) {
    console.error('Error toggling category status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to toggle category status',
      error: error.message
    });
  }
};

// @desc    Delete category
// @route   DELETE /api/categories/:id
// @access  Private/Admin
exports.deleteCategory = async (req, res) => {
  try {
    const category = await Category.findById(req.params.id);
    
    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    // Check if category has active consultations
    const consultationCount = await Consultation.countDocuments({ 
      category: category.name,
      isActive: true 
    });

    if (consultationCount > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete category with ${consultationCount} active consultation(s). Please deactivate or reassign consultations first.`
      });
    }

    await Category.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message: 'Category deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting category:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete category',
      error: error.message
    });
  }
};

// @desc    Sync category consultation counts
// @route   POST /api/categories/sync-counts
// @access  Private/Admin
exports.syncCategoryCounts = async (req, res) => {
  try {
    const categories = await Category.find();
    
    for (const category of categories) {
      const count = await Consultation.countDocuments({ 
        category: category.name,
        isActive: true 
      });
      category.consultationCount = count;
      await category.save();
    }

    res.json({
      success: true,
      message: 'Category counts synced successfully',
      data: categories
    });
  } catch (error) {
    console.error('Error syncing category counts:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to sync category counts',
      error: error.message
    });
  }
};
