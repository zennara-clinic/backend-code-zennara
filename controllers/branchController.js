const Branch = require('../models/Branch');
const { SESSION_SLOT_MINUTES } = require('../config/scheduling');

/**
 * Mongoose validation failures are the caller's fault, not the server's.
 * Returning 500 with a raw stack made the panel show "Server error" instead of
 * telling the user which field was missing.
 */
const validationError = (res, error) => {
  if (error.name === 'ValidationError') {
    return res.status(400).json({
      success: false,
      message: Object.values(error.errors).map((e) => e.message).join(', '),
    });
  }
  return null;
};


// Get all branches
exports.getAllBranches = async (req, res) => {
  try {
    const { activeOnly = 'true' } = req.query;
    
    const filter = {};
    if (activeOnly === 'true') {
      filter.isActive = true;
    }

    const branches = await Branch.find(filter)
      .sort({ displayOrder: 1, name: 1 })
      .lean();

    res.status(200).json({
      success: true,
      count: branches.length,
      data: branches.map((branch) => ({
        ...branch,
        slotDuration: SESSION_SLOT_MINUTES,
      }))
    });
  } catch (error) {
    console.error('Error fetching branches:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch branches',
      error: error.message
    });
  }
};

// Get single branch by ID
exports.getBranchById = async (req, res) => {
  try {
    const { id } = req.params;
    
    const branch = await Branch.findById(id);
    
    if (!branch) {
      return res.status(404).json({
        success: false,
        message: 'Branch not found'
      });
    }

    res.status(200).json({
      success: true,
      data: {
        ...branch.toObject(),
        slotDuration: SESSION_SLOT_MINUTES,
      }
    });
  } catch (error) {
    console.error('Error fetching branch:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch branch',
      error: error.message
    });
  }
};

// Get available slots for a branch on a specific date
exports.getBranchSlots = async (req, res) => {
  try {
    const { id } = req.params;
    const { date } = req.query;
    
    if (!date) {
      return res.status(400).json({
        success: false,
        message: 'Date parameter is required'
      });
    }

    const branch = await Branch.findById(id);
    
    if (!branch) {
      return res.status(404).json({
        success: false,
        message: 'Branch not found'
      });
    }

    if (!branch.isActive) {
      return res.status(400).json({
        success: false,
        message: 'Branch is currently inactive'
      });
    }

    const selectedDate = new Date(date);
    const slots = branch.getAvailableSlots(selectedDate);

    res.status(200).json({
      success: true,
      data: {
        branchId: branch._id,
        branchName: branch.name,
        date: selectedDate,
        slots: slots,
        slotDuration: SESSION_SLOT_MINUTES
      }
    });
  } catch (error) {
    console.error('Error fetching branch slots:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch branch slots',
      error: error.message
    });
  }
};

// Create new branch (Admin only)
exports.createBranch = async (req, res) => {
  try {
    const branchData = {
      ...req.body,
      slotDuration: SESSION_SLOT_MINUTES,
    };
    
    // Check if branch with same name exists
    const existingBranch = await Branch.findOne({ 
      name: new RegExp(`^${branchData.name}$`, 'i') 
    });
    
    if (existingBranch) {
      return res.status(400).json({
        success: false,
        message: 'Branch with this name already exists'
      });
    }

    const branch = await Branch.create(branchData);

    res.status(201).json({
      success: true,
      message: 'Branch created successfully',
      data: branch
    });
  } catch (error) {
    console.error('Error creating branch:', error);
    if (validationError(res, error)) return;
    res.status(500).json({
      success: false,
      message: 'Failed to create branch',
      error: error.message
    });
  }
};

// Update branch (Admin only)
exports.updateBranch = async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = {
      ...req.body,
      slotDuration: SESSION_SLOT_MINUTES,
    };

    // If name is being updated, check for duplicates
    if (updateData.name) {
      const existingBranch = await Branch.findOne({ 
        name: new RegExp(`^${updateData.name}$`, 'i'),
        _id: { $ne: id }
      });
      
      if (existingBranch) {
        return res.status(400).json({
          success: false,
          message: 'Branch with this name already exists'
        });
      }
    }

    // Doctors reference centres by NAME (availableCentres, branch). A rename
    // must follow into those documents or every doctor at this centre silently
    // unlinks — from the app's centre filter, the any-mode roster and the
    // availability sync.
    const before = await Branch.findById(id).select('name').lean();

    const branch = await Branch.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true }
    );

    if (!branch) {
      return res.status(404).json({
        success: false,
        message: 'Branch not found'
      });
    }

    if (before && updateData.name && before.name !== branch.name) {
      const Doctor = require('../models/Doctor');
      await Promise.all([
        Doctor.updateMany(
          { availableCentres: before.name },
          { $set: { 'availableCentres.$[el]': branch.name } },
          { arrayFilters: [{ el: before.name }] }
        ),
        Doctor.updateMany({ branch: before.name }, { $set: { branch: branch.name } }),
      ]);
    }

    res.status(200).json({
      success: true,
      message: 'Branch updated successfully',
      data: branch
    });
  } catch (error) {
    console.error('Error updating branch:', error);
    if (validationError(res, error)) return;
    res.status(500).json({
      success: false,
      message: 'Failed to update branch',
      error: error.message
    });
  }
};

// Toggle branch active status (Admin only)
exports.toggleBranchStatus = async (req, res) => {
  try {
    const { id } = req.params;
    
    const branch = await Branch.findById(id);
    
    if (!branch) {
      return res.status(404).json({
        success: false,
        message: 'Branch not found'
      });
    }

    branch.isActive = !branch.isActive;
    await branch.save();

    res.status(200).json({
      success: true,
      message: `Branch ${branch.isActive ? 'activated' : 'deactivated'} successfully`,
      data: branch
    });
  } catch (error) {
    console.error('Error toggling branch status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to toggle branch status',
      error: error.message
    });
  }
};

// Delete branch (Admin only - soft delete by setting isActive to false)
exports.deleteBranch = async (req, res) => {
  try {
    const { id } = req.params;
    const { permanent = false } = req.query;

    if (permanent === 'true') {
      // Permanent deletion
      const branch = await Branch.findByIdAndDelete(id);
      
      if (!branch) {
        return res.status(404).json({
          success: false,
          message: 'Branch not found'
        });
      }

      res.status(200).json({
        success: true,
        message: 'Branch permanently deleted'
      });
    } else {
      // Soft delete
      const branch = await Branch.findByIdAndUpdate(
        id,
        { isActive: false },
        { new: true }
      );
      
      if (!branch) {
        return res.status(404).json({
          success: false,
          message: 'Branch not found'
        });
      }

      res.status(200).json({
        success: true,
        message: 'Branch deactivated successfully',
        data: branch
      });
    }
  } catch (error) {
    console.error('Error deleting branch:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete branch',
      error: error.message
    });
  }
};

// Update branch display order (Admin only)
exports.updateBranchOrder = async (req, res) => {
  try {
    const { branches } = req.body; // Array of { id, displayOrder }
    
    if (!Array.isArray(branches)) {
      return res.status(400).json({
        success: false,
        message: 'Branches array is required'
      });
    }

    const updatePromises = branches.map(({ id, displayOrder }) =>
      Branch.findByIdAndUpdate(id, { displayOrder }, { new: true })
    );

    await Promise.all(updatePromises);

    res.status(200).json({
      success: true,
      message: 'Branch order updated successfully'
    });
  } catch (error) {
    console.error('Error updating branch order:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update branch order',
      error: error.message
    });
  }
};
