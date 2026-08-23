const DoctorFeeRequest = require('../models/DoctorFeeRequest');
const Doctor = require('../models/Doctor');
const AdminAuditLog = require('../models/AdminAuditLog');
const { effectiveFeeForDoctor, tierFee } = require('../utils/consultationPricing');

const { resolveDoctorForAdmin } = require('../utils/doctorIdentity');

/** The Doctor profile belonging to the signed-in account. */
async function myDoctorProfile(req) {
  return resolveDoctorForAdmin(req);
}

// @desc    List fee requests (admins see all; doctors see only their own)
// @route   GET /api/doctor-fee-requests
// @access  Admin (any staff role)
exports.getRequests = async (req, res) => {
  try {
    const { status, doctorId, mine } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (doctorId) filter.doctorId = String(doctorId).toLowerCase();

    // A doctor account only ever sees its own requests, whatever it asks for.
    if (req.admin.role === 'doctor' || mine === 'true') {
      const profile = await myDoctorProfile(req);
      if (!profile) {
        return res.status(200).json({
          success: true,
          count: 0,
          data: [],
          message: 'No doctor profile is linked to this login.',
        });
      }
      filter.doctorId = profile.doctorId;
    }

    const requests = await DoctorFeeRequest.find(filter)
      .sort({ status: 1, createdAt: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      count: requests.length,
      data: requests,
      stats: {
        pending: await DoctorFeeRequest.countDocuments({ ...filter, status: 'Pending' }),
      },
    });
  } catch (error) {
    console.error('Get fee requests error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch fee requests',
      error: error.message,
    });
  }
};

// @desc    What the signed-in doctor currently charges, and any open request
// @route   GET /api/doctor-fee-requests/my-fee
// @access  Admin (doctor)
exports.getMyFee = async (req, res) => {
  try {
    const profile = await myDoctorProfile(req);
    if (!profile) {
      return res.status(200).json({
        success: true,
        data: { linked: false },
        message: 'No doctor profile is linked to this login.',
      });
    }

    const { fee, source } = await effectiveFeeForDoctor(profile);
    const standard = await tierFee(profile.tier);
    const pending = await DoctorFeeRequest.pendingFor(profile.doctorId);

    return res.status(200).json({
      success: true,
      data: {
        linked: true,
        doctorId: profile.doctorId,
        doctorName: profile.name,
        tier: profile.tier,
        standardFee: standard,
        effectiveFee: fee,
        /** True when this doctor is on an approved personal rate. */
        hasOverride: source === 'doctor-override',
        pendingRequest: pending || null,
      },
    });
  } catch (error) {
    console.error('Get my fee error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch your consultation fee',
      error: error.message,
    });
  }
};

// @desc    Raise a fee-change request
// @route   POST /api/doctor-fee-requests
// @access  Admin (doctor raises their own; admin may raise on a doctor's behalf)
exports.createRequest = async (req, res) => {
  try {
    const { requestedFee, reason, doctorId } = req.body;

    // A doctor can only ever request against their own profile.
    let profile;
    if (req.admin.role === 'doctor' || !doctorId) {
      profile = await myDoctorProfile(req);
      if (!profile) {
        return res.status(400).json({
          success: false,
          message: 'No doctor profile is linked to this login, so there is no fee to change.',
        });
      }
    } else {
      profile = await Doctor.findOne({ doctorId: String(doctorId).toLowerCase() }).lean();
      if (!profile) {
        return res.status(404).json({ success: false, message: 'Doctor not found' });
      }
    }

    const amount = Number(requestedFee);
    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: 'Enter the fee you are requesting' });
    }

    const existing = await DoctorFeeRequest.pendingFor(profile.doctorId);
    if (existing) {
      return res.status(400).json({
        success: false,
        message: 'You already have a fee request awaiting review. Withdraw it before raising another.',
      });
    }

    const { fee: current, source } = await effectiveFeeForDoctor(profile);

    if (typeof current === 'number' && amount === current) {
      return res.status(400).json({
        success: false,
        message: `That is already your current fee (₹${current}).`,
      });
    }

    const request = await DoctorFeeRequest.create({
      doctorId: profile.doctorId,
      doctorName: profile.name,
      requestedBy: req.admin._id,
      requestedByEmail: req.admin.email,
      currentFee: current ?? 0,
      currentFeeWasTierFee: source !== 'doctor-override',
      requestedFee: amount,
      reason,
    });

    return res.status(201).json({
      success: true,
      message: 'Fee request submitted — an admin will review it.',
      data: request,
    });
  } catch (error) {
    console.error('Create fee request error:', error);
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        message: Object.values(error.errors).map((e) => e.message).join(', '),
      });
    }
    return res.status(500).json({
      success: false,
      message: 'Failed to submit the fee request',
      error: error.message,
    });
  }
};

// @desc    Approve a request, optionally at a different amount
// @route   PATCH /api/doctor-fee-requests/:id/approve
// @access  super_admin / admin
exports.approveRequest = async (req, res) => {
  try {
    const { approvedFee, reviewNote } = req.body;
    const request = await DoctorFeeRequest.findById(req.params.id);

    if (!request) {
      return res.status(404).json({ success: false, message: 'Fee request not found' });
    }
    if (request.status !== 'Pending') {
      return res.status(400).json({
        success: false,
        message: `This request was already ${request.status.toLowerCase()}.`,
      });
    }

    // The admin may accept the amount asked for, or set a different one.
    const finalFee = approvedFee !== undefined && approvedFee !== null && approvedFee !== ''
      ? Number(approvedFee)
      : request.requestedFee;

    if (!finalFee || finalFee <= 0) {
      return res.status(400).json({ success: false, message: 'The approved fee must be greater than zero' });
    }

    const doctor = await Doctor.findOne({ doctorId: request.doctorId });
    if (!doctor) {
      return res.status(404).json({ success: false, message: 'That doctor no longer exists' });
    }

    // This is what makes the new price live: the per-doctor override.
    doctor.fee = finalFee;
    await doctor.save();

    request.status = 'Approved';
    request.approvedFee = finalFee;
    request.reviewedBy = req.admin._id;
    request.reviewedByEmail = req.admin.email;
    request.reviewNote = reviewNote || null;
    request.decidedAt = new Date();
    await request.save();

    await AdminAuditLog.logAction({
      adminId: req.admin._id,
      adminEmail: req.admin.email,
      action: 'DOCTOR_FEE_APPROVED',
      resource: 'DOCTOR',
      resourceId: String(doctor._id),
      details: {
        doctor: doctor.name,
        doctorId: doctor.doctorId,
        from: request.currentFee,
        requested: request.requestedFee,
        approved: finalFee,
        adjusted: finalFee !== request.requestedFee,
        note: reviewNote || null,
      },
      ipAddress: req.adminIp || req.ip,
      userAgent: req.adminUserAgent,
    });

    return res.status(200).json({
      success: true,
      message: finalFee === request.requestedFee
        ? `Approved — ${doctor.name} now charges ₹${finalFee}.`
        : `Approved at ₹${finalFee} instead of the ₹${request.requestedFee} requested.`,
      data: request,
    });
  } catch (error) {
    console.error('Approve fee request error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to approve the fee request',
      error: error.message,
    });
  }
};

// @desc    Reject a request
// @route   PATCH /api/doctor-fee-requests/:id/reject
// @access  super_admin / admin
exports.rejectRequest = async (req, res) => {
  try {
    const { reviewNote } = req.body;

    if (!reviewNote || String(reviewNote).trim().length < 4) {
      return res.status(400).json({
        success: false,
        message: 'Give the doctor a reason — it is shown to them.',
      });
    }

    const request = await DoctorFeeRequest.findById(req.params.id);
    if (!request) {
      return res.status(404).json({ success: false, message: 'Fee request not found' });
    }
    if (request.status !== 'Pending') {
      return res.status(400).json({
        success: false,
        message: `This request was already ${request.status.toLowerCase()}.`,
      });
    }

    request.status = 'Rejected';
    request.reviewedBy = req.admin._id;
    request.reviewedByEmail = req.admin.email;
    request.reviewNote = String(reviewNote).trim();
    request.decidedAt = new Date();
    await request.save();

    await AdminAuditLog.logAction({
      adminId: req.admin._id,
      adminEmail: req.admin.email,
      action: 'DOCTOR_FEE_REJECTED',
      resource: 'DOCTOR',
      resourceId: request.doctorId,
      details: {
        doctor: request.doctorName,
        requested: request.requestedFee,
        note: request.reviewNote,
      },
      ipAddress: req.adminIp || req.ip,
      userAgent: req.adminUserAgent,
    });

    return res.status(200).json({
      success: true,
      message: 'Request rejected — the doctor can see your note.',
      data: request,
    });
  } catch (error) {
    console.error('Reject fee request error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to reject the fee request',
      error: error.message,
    });
  }
};

// @desc    Withdraw one's own pending request
// @route   PATCH /api/doctor-fee-requests/:id/withdraw
// @access  Admin (the doctor who raised it, or an admin)
exports.withdrawRequest = async (req, res) => {
  try {
    const request = await DoctorFeeRequest.findById(req.params.id);
    if (!request) {
      return res.status(404).json({ success: false, message: 'Fee request not found' });
    }
    if (request.status !== 'Pending') {
      return res.status(400).json({
        success: false,
        message: `This request was already ${request.status.toLowerCase()}.`,
      });
    }

    if (req.admin.role === 'doctor') {
      const profile = await myDoctorProfile(req);
      if (!profile || profile.doctorId !== request.doctorId) {
        return res.status(403).json({ success: false, message: 'That is not your request' });
      }
    }

    request.status = 'Withdrawn';
    request.decidedAt = new Date();
    await request.save();

    return res.status(200).json({ success: true, message: 'Request withdrawn', data: request });
  } catch (error) {
    console.error('Withdraw fee request error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to withdraw the request',
      error: error.message,
    });
  }
};

// @desc    Remove a doctor's personal rate, putting them back on the standard fee
// @route   DELETE /api/doctor-fee-requests/override/:doctorId
// @access  super_admin / admin
exports.clearOverride = async (req, res) => {
  try {
    const doctor = await Doctor.findOne({ doctorId: String(req.params.doctorId).toLowerCase() });
    if (!doctor) {
      return res.status(404).json({ success: false, message: 'Doctor not found' });
    }

    const previous = doctor.fee;
    doctor.fee = 0; // 0 means "use the tier fee"
    await doctor.save();

    const standard = await tierFee(doctor.tier);

    await AdminAuditLog.logAction({
      adminId: req.admin._id,
      adminEmail: req.admin.email,
      action: 'DOCTOR_FEE_APPROVED',
      resource: 'DOCTOR',
      resourceId: String(doctor._id),
      details: {
        doctor: doctor.name,
        description: 'Personal rate removed — back on the standard tier fee',
        from: previous,
        to: standard,
      },
      ipAddress: req.adminIp || req.ip,
      userAgent: req.adminUserAgent,
    });

    return res.status(200).json({
      success: true,
      message: `${doctor.name} is back on the standard fee${standard ? ` of ₹${standard}` : ''}.`,
      data: doctor,
    });
  } catch (error) {
    console.error('Clear override error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to clear the personal rate',
      error: error.message,
    });
  }
};
