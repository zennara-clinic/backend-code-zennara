const mongoose = require('mongoose');
const Branch = require('../models/Branch');
const DermatologistAvailability = require('../models/DermatologistAvailability');

const publicShape = (assignment) => ({
  doctorId: assignment.doctorId,
  branches: (assignment.branches || [])
    .filter((branch) => branch && branch.isActive !== false)
    .map((branch) => ({ _id: branch._id, name: branch.name })),
  isActive: assignment.isActive,
});

exports.getAll = async (req, res) => {
  try {
    const assignments = await DermatologistAvailability.find({ isActive: true })
      .populate('branches', 'name isActive')
      .sort({ doctorId: 1 })
      .lean();

    return res.status(200).json({
      success: true,
      count: assignments.length,
      data: assignments.map(publicShape),
    });
  } catch (error) {
    console.error('Error fetching dermatologist availability:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch dermatologist availability',
    });
  }
};

exports.getOne = async (req, res) => {
  try {
    const assignment = await DermatologistAvailability.findOne({
      doctorId: req.params.doctorId.toLowerCase(),
      isActive: true,
    })
      .populate('branches', 'name isActive')
      .lean();

    if (!assignment) {
      return res.status(404).json({
        success: false,
        message: 'Dermatologist availability not found',
      });
    }

    return res.status(200).json({ success: true, data: publicShape(assignment) });
  } catch (error) {
    console.error('Error fetching dermatologist availability:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch dermatologist availability',
    });
  }
};

exports.upsert = async (req, res) => {
  try {
    const doctorId = req.params.doctorId.trim().toLowerCase();
    const branchIds = Array.isArray(req.body.branchIds)
      ? [...new Set(req.body.branchIds.map(String))]
      : [];

    if (!doctorId) {
      return res.status(400).json({ success: false, message: 'doctorId is required' });
    }

    if (branchIds.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
      return res.status(400).json({ success: false, message: 'Invalid branch ID' });
    }

    const activeBranchCount = await Branch.countDocuments({
      _id: { $in: branchIds },
      isActive: true,
    });
    if (activeBranchCount !== branchIds.length) {
      return res.status(400).json({
        success: false,
        message: 'One or more selected branches are unavailable',
      });
    }

    const assignment = await DermatologistAvailability.findOneAndUpdate(
      { doctorId },
      {
        doctorId,
        branches: branchIds,
        isActive: req.body.isActive !== false,
        updatedBy: req.admin?._id || null,
      },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
    ).populate('branches', 'name isActive');

    return res.status(200).json({
      success: true,
      message: 'Dermatologist branches updated',
      data: publicShape(assignment),
    });
  } catch (error) {
    console.error('Error updating dermatologist availability:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update dermatologist availability',
    });
  }
};
