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

    // Every dermatologist gets a login. No email yet? Use a placeholder the
    // admin can replace later; the account still exists and can get a password.
    if (!body.email) body.email = `${doctorId}@dermatologist.zennara.in`;
    const doctor = await Doctor.create({ ...body, doctorId });
    await ensureDoctorLogin(doctor);
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
      // Dermatologists own their profile copy (qualifications, expertise,
      // experience, centres, photo, designation); the clinic owns identity,
      // pricing and visibility.
      ['fee', 'tier', 'level', 'isActive', 'displayOrder', 'email', 'phone', 'name'].forEach((k) => delete update[k]);
    }

    Object.assign(doctor, update);
    await doctor.save();
    await syncAvailability(doctor, req.admin?._id || null);
    if (req.admin?.role !== 'doctor') await ensureDoctorLogin(doctor);

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


/**
 * Keep a panel login (Admin, role 'doctor') in step with the profile: same
 * email and phone, linked by doctorId. Created on first save.
 */
async function ensureDoctorLogin(doctor) {
  const Admin = require('../models/Admin');
  if (!doctor || !doctor.email) return null;
  const email = String(doctor.email).toLowerCase();
  let account = await Admin.findOne({ doctorId: doctor._id });
  if (!account) account = await Admin.findOne({ email });
  if (!account) {
    account = await Admin.create({ email, name: doctor.name, role: 'doctor', doctorId: doctor._id, phone: doctor.phone || null, isActive: doctor.isActive !== false });
    return account;
  }
  let changed = false;
  if (account.email !== email) { account.email = email; changed = true; }
  if (!account.doctorId || String(account.doctorId) !== String(doctor._id)) { account.doctorId = doctor._id; changed = true; }
  if (account.name !== doctor.name) { account.name = doctor.name; changed = true; }
  if ((account.phone || null) !== (doctor.phone || null)) { account.phone = doctor.phone || null; changed = true; }
  if (changed) await account.save({ validateModifiedOnly: true });
  return account;
}
exports.ensureDoctorLogin = ensureDoctorLogin;

// @desc    The dermatologist's login account (email, phone, password state)
// @route   GET /api/doctors/:id/account
exports.getDoctorAccount = async (req, res) => {
  try {
    const Admin = require('../models/Admin');
    const doctor = await Doctor.findById(req.params.id);
    if (!doctor) return res.status(404).json({ success: false, message: 'Doctor not found' });
    const account = await ensureDoctorLogin(doctor);
    const withHash = account ? await Admin.findById(account._id).select('+passwordHash') : null;
    res.json({ success: true, data: account ? { _id: account._id, email: account.email, phone: account.phone, role: account.role, isActive: account.isActive, lastLogin: account.lastLogin, hasPassword: !!(withHash && withHash.passwordHash), passwordSetAt: account.passwordSetAt, placeholderEmail: /@dermatologist\.zennara\.in$/i.test(account.email) } : null });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Admin sets / resets the dermatologist's panel password
// @route   PUT /api/doctors/:id/account/password
exports.setDoctorPassword = async (req, res) => {
  try {
    const Admin = require('../models/Admin');
    const { password } = req.body || {};
    if (!password || String(password).length < 8) return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
    const doctor = await Doctor.findById(req.params.id);
    if (!doctor) return res.status(404).json({ success: false, message: 'Doctor not found' });
    const account = await ensureDoctorLogin(doctor);
    if (!account) return res.status(400).json({ success: false, message: 'Give the dermatologist an email first.' });
    const withHash = await Admin.findById(account._id).select('+passwordHash');
    withHash.setPassword(password);
    withHash.isActive = true;
    await withHash.save({ validateModifiedOnly: true });
    res.json({ success: true, message: `Password set. ${doctor.name} can sign in with ${account.email}.` });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

// @desc    Performance + activity for one dermatologist
// @route   GET /api/doctors/:id/stats?startDate&endDate
exports.getDoctorStats = async (req, res) => {
  try {
    const Booking = require('../models/Booking');
    const Consultation = require('../models/Consultation');
    const { consultationIdsByKind } = require('../utils/listFilters');
    const doctor = await Doctor.findById(req.params.id).lean();
    if (!doctor) return res.status(404).json({ success: false, message: 'Doctor not found' });
    const end = req.query.endDate ? new Date(req.query.endDate) : new Date(); end.setHours(23, 59, 59, 999);
    const start = req.query.startDate ? new Date(req.query.startDate) : new Date(end.getTime() - 89 * 86400000); start.setHours(0, 0, 0, 0);
    const { consult } = await consultationIdsByKind();
    const consultSet = new Set(consult.map(String));
    const isConsult = (b) => (b.consultationId ? consultSet.has(String(b.consultationId._id || b.consultationId)) : /consult|counsel/i.test(b.externalServiceName || ''));
    const slotIn = { $or: [{ confirmedDate: { $gte: start, $lte: end } }, { confirmedDate: null, preferredDate: { $gte: start, $lte: end } }] };
    const mine = { $or: [{ specialistId: doctor.doctorId }, { specialistName: doctor.name }] };
    const [rows, allTime] = await Promise.all([
      Booking.find({ $and: [mine, slotIn] }).populate('consultationId', 'name category').select('consultationId externalServiceName status amount paymentStatus confirmedDate preferredDate confirmedTime slotTime preferredTimeSlots rating feedback userId fullName source preferredLocation checkInTime checkOutTime sessionDuration').sort({ confirmedDate: -1, preferredDate: -1 }).lean(),
      Booking.aggregate([{ $match: mine }, { $group: { _id: null, bookings: { $sum: 1 }, completed: { $sum: { $cond: [{ $eq: ['$status', 'Completed'] }, 1, 0] } }, revenue: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'paid'] }, '$amount', 0] } }, patients: { $addToSet: '$userId' } } }]),
    ]);
    const sum = (arr, f) => arr.reduce((n, x) => n + (Number(f(x)) || 0), 0);
    const paid = rows.filter((b) => b.paymentStatus === 'paid');
    const ratings = rows.filter((b) => b.rating);
    const byMonth = {};
    rows.forEach((b) => { const d = new Date(b.confirmedDate || b.preferredDate); const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; byMonth[k] = byMonth[k] || { month: k, bookings: 0, consultations: 0, treatments: 0, revenue: 0 }; byMonth[k].bookings += 1; if (isConsult(b)) byMonth[k].consultations += 1; else byMonth[k].treatments += 1; if (b.paymentStatus === 'paid') byMonth[k].revenue += Number(b.amount) || 0; });
    const svc = {};
    rows.forEach((b) => { const n = (b.consultationId && b.consultationId.name) || b.externalServiceName || 'Other'; svc[n] = svc[n] || { name: n, bookings: 0, revenue: 0 }; svc[n].bookings += 1; if (b.paymentStatus === 'paid') svc[n].revenue += Number(b.amount) || 0; });
    const centres = {};
    rows.forEach((b) => { const c = b.preferredLocation || '—'; centres[c] = (centres[c] || 0) + 1; });
    res.json({
      success: true,
      data: {
        period: { startDate: start, endDate: end },
        summary: {
          bookings: rows.length, consultations: rows.filter(isConsult).length, treatments: rows.filter((b) => !isConsult(b)).length,
          completed: rows.filter((b) => b.status === 'Completed').length, noShow: rows.filter((b) => b.status === 'No Show').length, cancelled: rows.filter((b) => b.status === 'Cancelled').length,
          upcoming: rows.filter((b) => ['Confirmed', 'Awaiting Confirmation', 'Rescheduled'].includes(b.status)).length,
          revenue: sum(paid, (b) => b.amount), consultationRevenue: sum(paid.filter(isConsult), (b) => b.amount), treatmentRevenue: sum(paid.filter((b) => !isConsult(b)), (b) => b.amount),
          patients: new Set(rows.map((b) => String(b.userId)).filter(Boolean)).size,
          avgRating: ratings.length ? Math.round((sum(ratings, (b) => b.rating) / ratings.length) * 10) / 10 : null, ratings: ratings.length,
          avgSessionMinutes: (() => { const s = rows.filter((b) => b.sessionDuration); return s.length ? Math.round(sum(s, (b) => b.sessionDuration) / s.length) : null; })(),
        },
        allTime: allTime[0] ? { bookings: allTime[0].bookings, completed: allTime[0].completed, revenue: allTime[0].revenue, patients: allTime[0].patients.filter(Boolean).length } : { bookings: 0, completed: 0, revenue: 0, patients: 0 },
        byMonth: Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month)),
        topServices: Object.values(svc).sort((a, b) => b.bookings - a.bookings).slice(0, 10),
        byCentre: Object.entries(centres).map(([centre, n]) => ({ centre, bookings: n })),
        recent: rows.slice(0, 25).map((b) => ({ _id: b._id, guest: b.fullName, userId: b.userId, service: (b.consultationId && b.consultationId.name) || b.externalServiceName, kind: isConsult(b) ? 'consultation' : 'treatment', date: b.confirmedDate || b.preferredDate, time: b.confirmedTime || b.slotTime || (b.preferredTimeSlots && b.preferredTimeSlots[0]) || '', status: b.status, amount: b.amount, paymentStatus: b.paymentStatus, rating: b.rating, feedback: b.feedback, source: b.source })),
        feedback: ratings.filter((b) => b.feedback).slice(0, 10).map((b) => ({ guest: b.fullName, rating: b.rating, feedback: b.feedback, date: b.confirmedDate || b.preferredDate })),
      },
    });
  } catch (error) {
    console.error('Doctor stats error:', error);
    res.status(500).json({ success: false, message: 'Failed to load dermatologist stats' });
  }
};
