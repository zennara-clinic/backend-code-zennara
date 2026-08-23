const Doctor = require('../models/Doctor');
const { canEditDoctor, resolveDoctorForAdmin } = require('../utils/doctorIdentity');
const DoctorTier = require('../models/DoctorTier');
const Booking = require('../models/Booking');
const DermatologistAvailability = require('../models/DermatologistAvailability');
const Branch = require('../models/Branch');
const { syncCatalogueForTier, effectiveFeeForDoctor } = require('../utils/consultationPricing');

/* --------------------------------- helpers -------------------------------- */

/**
 * Keep DermatologistAvailability in step with the centre names on the profile.
 * The panel edits centres by name (that is what the clinic thinks in); the slot
 * engine needs branch _ids, so we translate here rather than asking every
 * caller to keep two collections aligned by hand.
 */
async function syncAvailability(doctor, adminId = null) {
  const names = (doctor.availableCentres || []).map((n) => String(n).trim()).filter(Boolean);
  const branches = names.length
    ? await Branch.find({ name: { $in: names }, isActive: true }).select('_id').lean()
    : [];

  await DermatologistAvailability.findOneAndUpdate(
    { doctorId: doctor.doctorId },
    {
      doctorId: doctor.doctorId,
      branches: branches.map((b) => b._id),
      isActive: doctor.isActive,
      updatedBy: adminId,
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
}

const ALLOWED = [
  'name', 'photo', 'tier', 'level', 'designation', 'branch', 'availableCentres',
  'qualifications', 'experienceYears', 'experienceNote', 'expertise', 'achievements',
  'fee', 'email', 'phone', 'displayOrder', 'isActive',
];

function pickBody(body) {
  const out = {};
  for (const key of ALLOWED) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  return out;
}

/* ---------------------------------- reads --------------------------------- */

// @desc    List doctors
// @route   GET /api/doctors
// @access  Public
exports.getAllDoctors = async (req, res) => {
  try {
    const { tier, branch, search, isActive, includeInactive } = req.query;

    const filter = {};
    // Public callers only ever see the active team; the panel opts in.
    if (isActive !== undefined) filter.isActive = isActive === 'true';
    else if (includeInactive !== 'true') filter.isActive = true;

    if (tier) filter.tier = tier;
    if (branch) filter.availableCentres = branch;
    if (search) {
      const rx = new RegExp(String(search).trim(), 'i');
      filter.$or = [{ name: rx }, { designation: rx }, { expertise: rx }];
    }

    // Contact details are for the panel only; the app sees the public profile.
    const projection = req.admin ? {} : { email: 0, phone: 0 };

    const doctors = await Doctor.find(filter, projection)
      .sort({ displayOrder: 1, tier: 1, name: 1 })
      .lean();

    return res.status(200).json({
      success: true,
      count: doctors.length,
      data: doctors,
    });
  } catch (error) {
    console.error('Get doctors error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch doctors',
      error: error.message,
    });
  }
};

// @desc    Get one doctor by _id or doctorId slug
// @route   GET /api/doctors/:id
// @access  Public
exports.getDoctorById = async (req, res) => {
  try {
    const { id } = req.params;
    const doctor = await Doctor.findOne({
      $or: [
        ...(id.match(/^[0-9a-fA-F]{24}$/) ? [{ _id: id }] : []),
        { doctorId: id.toLowerCase() },
      ],
    }, req.admin ? {} : { email: 0, phone: 0 }).lean();

    if (!doctor) {
      return res.status(404).json({ success: false, message: 'Doctor not found' });
    }

    return res.status(200).json({ success: true, data: doctor });
  } catch (error) {
    console.error('Get doctor error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch doctor',
      error: error.message,
    });
  }
};

// @desc    List consultation tiers and fees
// @route   GET /api/doctors/tiers/list
// @access  Public
exports.getTiers = async (req, res) => {
  try {
    const tiers = await DoctorTier.find({ isActive: true }).sort({ displayOrder: 1 }).lean();
    return res.status(200).json({
      success: true,
      count: tiers.length,
      data: tiers.map((t) => ({
        id: t.tierId,
        title: t.title,
        description: t.description,
        fee: t.fee,
      })),
    });
  } catch (error) {
    console.error('Get tiers error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch consultation tiers',
      error: error.message,
    });
  }
};

// @desc    Update a tier's fee/title
// @route   PUT /api/doctors/tiers/:tierId
// @access  Admin
exports.updateTier = async (req, res) => {
  try {
    const { title, description, fee, isActive, displayOrder } = req.body;
    const update = {};
    if (title !== undefined) update.title = title;
    if (description !== undefined) update.description = description;
    if (fee !== undefined) update.fee = Number(fee);
    if (isActive !== undefined) update.isActive = isActive;
    if (displayOrder !== undefined) update.displayOrder = Number(displayOrder);

    const tier = await DoctorTier.findOneAndUpdate(
      { tierId: req.params.tierId },
      update,
      { new: true, runValidators: true },
    );

    if (!tier) {
      return res.status(404).json({ success: false, message: 'Tier not found' });
    }

    // The catalogue entry is what listings display and what the old payment
    // path charged against, so a tier fee change has to reach it too —
    // otherwise the panel shows one price and the app charges another.
    let synced = null;
    if (update.fee !== undefined) {
      synced = await syncCatalogueForTier(tier.tierId, tier.fee);
    }

    // How many doctors this actually applies to (those without a personal rate).
    const onStandard = await Doctor.countDocuments({
      tier: tier.tierId,
      $or: [{ fee: 0 }, { fee: null }, { fee: { $exists: false } }],
    });

    return res.status(200).json({
      success: true,
      message: update.fee !== undefined
        ? `Standard fee updated — applies to ${onStandard} doctor${onStandard === 1 ? '' : 's'} on this tier.`
        : 'Tier updated',
      data: tier,
      meta: { catalogueSynced: !!synced, doctorsOnStandardFee: onStandard },
    });
  } catch (error) {
    console.error('Update tier error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update tier',
      error: error.message,
    });
  }
};

/* --------------------------------- writes --------------------------------- */

// @desc    Create a doctor
// @route   POST /api/doctors
// @access  Admin
exports.createDoctor = async (req, res) => {
  try {
    const body = pickBody(req.body);

    if (!body.name || !body.tier) {
      return res.status(400).json({
        success: false,
        message: 'Doctor name and tier are required',
      });
    }

    const doctorId = (req.body.doctorId && Doctor.slugify(req.body.doctorId))
      || Doctor.slugify(body.name);

    if (!doctorId) {
      return res.status(400).json({ success: false, message: 'Could not derive a doctorId from the name' });
    }

    const clash = await Doctor.findOne({ doctorId });
    if (clash) {
      return res.status(400).json({
        success: false,
        message: `A doctor with the id "${doctorId}" already exists`,
      });
    }

    const doctor = await Doctor.create({ ...body, doctorId });
    await syncAvailability(doctor, req.admin?._id || null);

    return res.status(201).json({
      success: true,
      message: 'Doctor created successfully',
      data: doctor,
    });
  } catch (error) {
    console.error('Create doctor error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create doctor',
      error: error.message,
    });
  }
};

// @desc    Update a doctor
// @route   PUT /api/doctors/:id
// @access  Admin
exports.updateDoctor = async (req, res) => {
  try {
    const { id } = req.params;
    const doctor = await Doctor.findOne({
      $or: [
        ...(id.match(/^[0-9a-fA-F]{24}$/) ? [{ _id: id }] : []),
        { doctorId: id.toLowerCase() },
      ],
    });

    if (!doctor) {
      return res.status(404).json({ success: false, message: 'Doctor not found' });
    }

    // A doctor may edit only their own profile.
    if (!(await canEditDoctor(req, doctor))) {
      return res.status(403).json({ success: false, message: 'You can only edit your own profile' });
    }

    // doctorId is deliberately immutable: bookings, availability rows and the
    // app's deep links all point at it.
    const update = pickBody(req.body);

    // A doctor may edit their own profile, but never their own price. Fees move
    // only through an admin-approved request (/api/doctor-fee-requests), so the
    // rule is enforced here rather than trusting the client to omit the field.
    if (req.admin?.role === 'doctor') {
      delete update.fee;
      delete update.tier;
      delete update.isActive;
      delete update.displayOrder;
    }

    Object.assign(doctor, update);
    await doctor.save();
    await syncAvailability(doctor, req.admin?._id || null);

    return res.status(200).json({
      success: true,
      message: 'Doctor updated successfully',
      data: doctor,
    });
  } catch (error) {
    console.error('Update doctor error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update doctor',
      error: error.message,
    });
  }
};

// @desc    Activate / deactivate a doctor
// @route   PATCH /api/doctors/:id/toggle-status
// @access  Admin
exports.toggleDoctorStatus = async (req, res) => {
  try {
    const doctor = await Doctor.findById(req.params.id);
    if (!doctor) {
      return res.status(404).json({ success: false, message: 'Doctor not found' });
    }

    doctor.isActive = !doctor.isActive;
    await doctor.save();
    await syncAvailability(doctor, req.admin?._id || null);

    return res.status(200).json({
      success: true,
      message: `Doctor ${doctor.isActive ? 'activated' : 'deactivated'} successfully`,
      data: doctor,
    });
  } catch (error) {
    console.error('Toggle doctor error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to toggle doctor status',
      error: error.message,
    });
  }
};

// @desc    Delete a doctor
// @route   DELETE /api/doctors/:id
// @access  Admin
exports.deleteDoctor = async (req, res) => {
  try {
    const doctor = await Doctor.findById(req.params.id);
    if (!doctor) {
      return res.status(404).json({ success: false, message: 'Doctor not found' });
    }

    // Bookings reference the doctor by slug. Deleting a doctor with history
    // would orphan those records, so we deactivate instead and say so.
    const bookingCount = await Booking.countDocuments({ specialistId: doctor.doctorId });
    if (bookingCount > 0) {
      doctor.isActive = false;
      await doctor.save();
      await syncAvailability(doctor, req.admin?._id || null);
      return res.status(200).json({
        success: true,
        message: `${doctor.name} has ${bookingCount} booking(s) on record and was deactivated instead of deleted.`,
        data: doctor,
      });
    }

    await Doctor.deleteOne({ _id: doctor._id });
    await DermatologistAvailability.deleteOne({ doctorId: doctor.doctorId });

    return res.status(200).json({ success: true, message: 'Doctor deleted successfully' });
  } catch (error) {
    console.error('Delete doctor error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete doctor',
      error: error.message,
    });
  }
};


// @desc    The Doctor profile behind the signed-in staff login (role doctor)
// @route   GET /api/doctors/me
// @access  Staff
exports.getMyDoctor = async (req, res) => {
  try {
    const doctor = await resolveDoctorForAdmin(req);
    return res.status(200).json({ success: true, linked: !!doctor, data: doctor });
  } catch (error) {
    console.error('Get my doctor error:', error);
    return res.status(500).json({ success: false, message: 'Failed to resolve doctor profile' });
  }
};
