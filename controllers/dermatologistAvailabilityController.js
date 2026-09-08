const mongoose = require('mongoose');
const Branch = require('../models/Branch');
const Doctor = require('../models/Doctor');
const DermatologistAvailability = require('../models/DermatologistAvailability');

const publicShape = (assignment) => ({
  doctorId: assignment.doctorId,
  branches: (assignment.branches || [])
    .filter((branch) => branch && branch.isActive !== false)
    .map((branch) => ({ _id: branch._id, name: branch.name })),
  isActive: assignment.isActive,
});

/*
 * Where a dermatologist works has ONE answer: Doctor.availableCentres, which
 * the Zenoti practitioner sync rewrites every five minutes.
 *
 * This endpoint used to read a separate DermatologistAvailability collection,
 * maintained by hand, and the APP filters its dermatologist list on THIS
 * response — so the stale copy is what guests actually saw. On 2026-09-08 it
 * still offered Janaki at Financial District and Kondapur (Zenoti has her at
 * Jubilee Hills alone) and hid Rickson at Financial District, where Zenoti
 * does roster him. Fixing Doctor.availableCentres changed nothing on screen,
 * because the app was never reading it.
 *
 * The response shape is unchanged — the app depends on it — but the branches
 * now come from the doctor record. The old collection is still written by the
 * panel's upsert and is used only as a fallback for a doctorId that has no
 * Doctor row at all.
 */
async function derivedFromDoctors() {
  const [doctors, branches] = await Promise.all([
    Doctor.find({ isActive: { $ne: false } }).select('doctorId availableCentres isActive').lean(),
    Branch.find({ isActive: true }).select('name').lean(),
  ]);
  const byName = new Map(branches.map((b) => [String(b.name).trim().toLowerCase(), b]));
  return doctors.map((doc) => ({
    doctorId: doc.doctorId,
    branches: (doc.availableCentres || [])
      .map((name) => byName.get(String(name).trim().toLowerCase()))
      .filter(Boolean)
      .map((b) => ({ _id: b._id, name: b.name })),
    isActive: doc.isActive !== false,
  }));
}

exports.getAll = async (req, res) => {
  try {
    const derived = await derivedFromDoctors();
    const known = new Set(derived.map((row) => row.doctorId));
    // Legacy rows for a doctorId with no Doctor record — kept so nothing
    // silently disappears from an older client.
    const orphans = (await DermatologistAvailability.find({ isActive: true })
      .populate('branches', 'name isActive').lean())
      .filter((a) => !known.has(a.doctorId))
      .map(publicShape);
    const data = [...derived, ...orphans].sort((a, b) => a.doctorId.localeCompare(b.doctorId));

    return res.status(200).json({ success: true, count: data.length, data });
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
    const wanted = req.params.doctorId.toLowerCase();
    const fromDoctor = (await derivedFromDoctors()).find((row) => row.doctorId === wanted);
    if (fromDoctor) return res.status(200).json({ success: true, data: fromDoctor });

    const assignment = await DermatologistAvailability.findOne({
      doctorId: wanted,
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
