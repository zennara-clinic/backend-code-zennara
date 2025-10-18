const Formulation = require('../models/Formulation');
const Product = require('../models/Product');

// @desc    Get all formulations
// @route   GET /api/admin/formulations
// @access  Private (Admin)
exports.getAllFormulations = async (req, res) => {
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
    
    const formulations = await Formulation.find(query).sort({ name: 1 });
    
    // Update products count for each formulation
    for (let formulation of formulations) {
      const count = await Product.countDocuments({ formulation: formulation.name });
      if (formulation.productsCount !== count) {
        formulation.productsCount = count;
        await formulation.save();
      }
    }
    
    res.json({
      success: true,
      data: formulations
    });
  } catch (error) {
    console.error('Error fetching formulations:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch formulations',
      error: error.message
    });
  }
};

// @desc    Get single formulation
// @route   GET /api/admin/formulations/:id
// @access  Private (Admin)
exports.getFormulationById = async (req, res) => {
  try {
    const formulation = await Formulation.findById(req.params.id);
    
    if (!formulation) {
      return res.status(404).json({
        success: false,
        message: 'Formulation not found'
      });
    }
    
    // Update products count
    const count = await Product.countDocuments({ formulation: formulation.name });
    formulation.productsCount = count;
    await formulation.save();
    
    res.json({
      success: true,
      data: formulation
    });
  } catch (error) {
    console.error('Error fetching formulation:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch formulation',
      error: error.message
    });
  }
};

// @desc    Create new formulation
// @route   POST /api/admin/formulations
// @access  Private (Admin)
exports.createFormulation = async (req, res) => {
  try {
    const { name, description, isActive } = req.body;
    
    // Check if formulation already exists
    const existingFormulation = await Formulation.findOne({ name });
    if (existingFormulation) {
      return res.status(400).json({
        success: false,
        message: 'Formulation with this name already exists'
      });
    }
    
    const formulation = await Formulation.create({
      name,
      description,
      isActive
    });
    
    res.status(201).json({
      success: true,
      message: 'Formulation created successfully',
      data: formulation
    });
  } catch (error) {
    console.error('Error creating formulation:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create formulation',
      error: error.message
    });
  }
};

// @desc    Update formulation
// @route   PUT /api/admin/formulations/:id
// @access  Private (Admin)
exports.updateFormulation = async (req, res) => {
  try {
    const { name, description, isActive } = req.body;
    
    const formulation = await Formulation.findById(req.params.id);
    
    if (!formulation) {
      return res.status(404).json({
        success: false,
        message: 'Formulation not found'
      });
    }
    
    // If name is being changed, check for duplicates
    if (name && name !== formulation.name) {
      const existingFormulation = await Formulation.findOne({ name });
      if (existingFormulation) {
        return res.status(400).json({
          success: false,
          message: 'Formulation with this name already exists'
        });
      }
      
      // Update all products with old formulation name
      await Product.updateMany(
        { formulation: formulation.name },
        { formulation: name }
      );
    }
    
    formulation.name = name || formulation.name;
    formulation.description = description !== undefined ? description : formulation.description;
    formulation.isActive = isActive !== undefined ? isActive : formulation.isActive;
    
    await formulation.save();
    
    res.json({
      success: true,
      message: 'Formulation updated successfully',
      data: formulation
    });
  } catch (error) {
    console.error('Error updating formulation:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update formulation',
      error: error.message
    });
  }
};

// @desc    Delete formulation
// @route   DELETE /api/admin/formulations/:id
// @access  Private (Admin)
exports.deleteFormulation = async (req, res) => {
  try {
    const formulation = await Formulation.findById(req.params.id);
    
    if (!formulation) {
      return res.status(404).json({
        success: false,
        message: 'Formulation not found'
      });
    }
    
    // Check if formulation has products
    const productsCount = await Product.countDocuments({ formulation: formulation.name });
    if (productsCount > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete formulation. ${productsCount} product(s) are using this formulation.`
      });
    }
    
    await formulation.deleteOne();
    
    res.json({
      success: true,
      message: 'Formulation deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting formulation:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete formulation',
      error: error.message
    });
  }
};

// @desc    Get formulation statistics
// @route   GET /api/admin/formulations/statistics
// @access  Private (Admin)
exports.getFormulationStatistics = async (req, res) => {
  try {
    const totalFormulations = await Formulation.countDocuments();
    const activeFormulations = await Formulation.countDocuments({ isActive: true });
    const inactiveFormulations = await Formulation.countDocuments({ isActive: false });
    
    // Get formulations with most products
    const formulations = await Formulation.find().sort({ productsCount: -1 }).limit(5);
    
    res.json({
      success: true,
      data: {
        total: totalFormulations,
        active: activeFormulations,
        inactive: inactiveFormulations,
        topFormulations: formulations
      }
    });
  } catch (error) {
    console.error('Error fetching formulation statistics:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch formulation statistics',
      error: error.message
    });
  }
};
