const mongoose = require('mongoose');
const Branch = require('../models/Branch');
const Doctor = require('../models/Doctor');
const DermatologistAvailability = require('../models/DermatologistAvailability');
const ZenotiPractitioner = require('../models/ZenotiPractitioner');

const publicShape = (assignment) => ({
  doctorId: assignment.doctorId,
  branches: (assignment.branches || [])
    .filter((branch) => branch && branch.isActive !== false)
    .map((branch) => ({ _id: branch._id, name: branch.name })),
  isActive: assignment.isActive,
});

/*
 * Where a dermatologist works has ONE answer, and it is the same one the slot
 * engine uses: the Zenoti practitioner links, with Doctor.availableCentres as
 * the fallback for a dermatologist Zenoti has never heard of.
 *
 * This endpoint used to read a separate DermatologistAvailability collection,
 * maintained by hand, and the APP filters its dermatologist list on THIS
 * response — so the stale copy is what guests actually saw. On 2026-09-08 it
 * still offered Janaki at Financial District and Kondapur (Zenoti has her at
 * Jubilee Hills alone) and hid Rickson at Financial District, where Zenoti
 * does roster him. Reading Doctor.availableCentres instead fixed the source of
 * the copy but not the disagreement: zenotiAvailabilityService.candidateBranches
 * had already stopped trusting that hand-typed list, because it had drifted for
 * seven of nine active dermatologists. The two therefore still answered
 * different questions — the app hid a dermatologist from a centre Zenoti
 * rosters them at, or listed them at a centre whose calendar comes back empty.
 *
 * The rule below is candidateBranches' rule, deliberately line for line:
 * active clinic centres, filtered by the Zenoti link when there is one, by the
 * panel's list when there is not, and unfiltered for a dermatologist with
 * neither (which is what the slot engine already assumes).
 *
 * The response shape is unchanged — the app depends on it. The old collection
 * is still written by the panel's upsert and is used only as a fallback for a
 * doctorId that has no Doctor row at all.
 */
const norm = (value) => String(value || '').trim().toLowerCase();

async function derivedFromDoctors() {
  const [doctors, branches] = await Promise.all([
    Doctor.find({ isActive: { $ne: false } }).select('doctorId availableCentres isActive').lean(),
    // Pharmacies and the training centre are stock locations, never bookable.
    Branch.find({ isActive: true, centreType: 'clinic' })
      .select('name zenotiCenterId').sort({ displayOrder: 1, name: 1 }).lean(),
  ]);

  const links = await ZenotiPractitioner.find({
    onboardedDoctorId: { $in: doctors.map((doc) => norm(doc.doctorId)) },
    active: true,
  }).select('onboardedDoctorId centerIds').lean();
  const centresByDoctor = new Map();
  for (const link of links) {
    const key = norm(link.onboardedDoctorId);
    const centres = centresByDoctor.get(key) || new Set();
    (link.centerIds || []).forEach((id) => centres.add(norm(id)));
    centresByDoctor.set(key, centres);
  }

  return doctors.map((doc) => {
    const linked = centresByDoctor.get(norm(doc.doctorId));
    const mine = linked && linked.size
      ? branches.filter((branch) => linked.has(norm(branch.zenotiCenterId)))
      : branches.filter((branch) => !doc.availableCentres?.length
        || doc.availableCentres.some((name) => norm(name) === norm(branch.name)));
    return {
      doctorId: doc.doctorId,
      branches: mine.map((branch) => ({ _id: branch._id, name: branch.name })),
      isActive: doc.isActive !== false,
    };
  });
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
