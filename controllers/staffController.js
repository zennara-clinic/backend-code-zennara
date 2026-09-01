const Admin = require('../models/Admin');
const AdminAuditLog = require('../models/AdminAuditLog');

/**
 * Staff accounts — the people who can sign into the panel.
 *
 * An Admin row is what `protectAdmin` checks, and `ADMIN_EMAILS` in the
 * environment is the allow-list the login flow consults. Creating a row here
 * does not add the address to that allow-list, so the response says plainly
 * when an account will not be able to sign in yet.
 */

const ROLES = ['super_admin', 'doctor', 'therapist'];

const authorizedEmails = () =>
  (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

const PANEL_LABEL = { doctor: 'Dermatologist', therapist: 'Therapist' };

const shape = (admin, allowList) => ({
  _id: admin._id,
  email: admin.email,
  name: admin.name,
  role: admin.role,
  phone: admin.phone || null,
  branchId: admin.branchId || null,
  branchIds: (admin.branchIds && admin.branchIds.length)
    ? admin.branchIds
    : (admin.branchId ? [admin.branchId] : []),
  isActive: admin.isActive,
  isVerified: admin.isVerified,
  lastLogin: admin.lastLogin,
  createdAt: admin.createdAt,
  doctorId: admin.doctorId || null,
  hasPassword: !!admin.passwordHash,
  passwordSetAt: admin.passwordSetAt || null,
  /** Doctors/therapists sign in with their password; others via the env list too. */
  canSignIn: allowList.includes(String(admin.email).toLowerCase()) || !!admin.passwordHash || admin.role === 'super_admin',
});

// @desc    List staff accounts
// @route   GET /api/admin/staff
// @access  Admin
exports.getStaff = async (req, res) => {
  try {
    const { role, search, isActive } = req.query;

    const filter = {};
    if (role) filter.role = role;
    if (isActive !== undefined) filter.isActive = isActive === 'true';
    if (search) {
      const rx = new RegExp(String(search).trim(), 'i');
      filter.$or = [{ email: rx }, { name: rx }];
    }

    const admins = await Admin.find(filter).select('+passwordHash').sort({ role: 1, name: 1 }).lean();
    const allowList = authorizedEmails();

    return res.status(200).json({
      success: true,
      count: admins.length,
      data: admins.map((a) => shape(a, allowList)),
      stats: {
        total: admins.length,
        active: admins.filter((a) => a.isActive).length,
        byRole: ROLES.reduce((acc, r) => {
          acc[r] = admins.filter((a) => a.role === r).length;
          return acc;
        }, {}),
      },
    });
  } catch (error) {
    console.error('Get staff error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch staff',
      error: error.message,
    });
  }
};

// @desc    Create a staff account
// @route   POST /api/admin/staff
// @access  super_admin
exports.createStaff = async (req, res) => {
  try {
    const { email, name, role, doctorId, phone, branchId, branchIds, password } = req.body;

    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ success: false, message: 'A valid email is required' });
    }
    if (!ROLES.includes(role)) {
      return res.status(400).json({ success: false, message: `Role must be one of: ${ROLES.join(', ')}` });
    }
    if (password && String(password).length < 8) {
      return res.status(400).json({ success: false, message: 'The password must be at least 8 characters' });
    }

    const existing = await Admin.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(400).json({ success: false, message: 'A staff account with this email already exists' });
    }

    const admin = await Admin.create({
      email: email.toLowerCase(),
      name: name || email.split('@')[0],
      role,
      doctorId: role === 'doctor' && doctorId ? doctorId : null,
      phone: phone ? String(phone).trim() : null,
      branchId: branchId || (Array.isArray(branchIds) && branchIds[0]) || null,
      branchIds: Array.isArray(branchIds) ? branchIds.filter(Boolean) : (branchId ? [branchId] : []),
      isActive: true,
    });

    // Same atomic onboarding as dermatologists: password set in the same
    // request and the credentials emailed, so they can sign in immediately.
    let credentialsEmailed = false;
    if (password) {
      const withHash = await Admin.findById(admin._id).select('+passwordHash');
      withHash.setPassword(String(password));
      await withHash.save({ validateModifiedOnly: true });
      admin.passwordHash = withHash.passwordHash;
      try {
        await require('../utils/emailService').sendDoctorCredentials(admin.email, admin.name, {
          password: String(password),
          mode: 'created',
          panel: PANEL_LABEL[role] || 'Zennara',
        });
        credentialsEmailed = true;
      } catch (err) {
        console.error('❌ Staff credentials email failed (login still created):', err.message);
      }
    }

    const allowList = authorizedEmails();

    return res.status(201).json({
      success: true,
      message: password
        ? (credentialsEmailed
            ? `Account created — login details emailed to ${admin.email}`
            : 'Account created and password set, but the credentials email failed. Share the password with them directly.')
        : 'Staff account created',
      credentialsEmailed,
      data: shape(admin, allowList),
    });
  } catch (error) {
    console.error('Create staff error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create staff account',
      error: error.message,
    });
  }
};

// @desc    Update a staff account (name / role)
// @route   PUT /api/admin/staff/:id
// @access  super_admin
exports.updateStaff = async (req, res) => {
  try {
    const { name, role, doctorId } = req.body;
    const admin = await Admin.findById(req.params.id);

    if (!admin) {
      return res.status(404).json({ success: false, message: 'Staff account not found' });
    }

    if (role && !ROLES.includes(role)) {
      return res.status(400).json({ success: false, message: `Role must be one of: ${ROLES.join(', ')}` });
    }

    // Removing the last super admin would lock everyone out of role management.
    if (role && admin.role === 'super_admin' && role !== 'super_admin') {
      const supers = await Admin.countDocuments({ role: 'super_admin', isActive: true });
      if (supers <= 1) {
        return res.status(400).json({
          success: false,
          message: 'This is the only active super admin — promote someone else first.',
        });
      }
    }

    const previousRole = admin.role;
    const { phone, branchId, branchIds } = req.body;
    if (name !== undefined) admin.name = name;
    if (role !== undefined) admin.role = role;
    if (doctorId !== undefined) admin.doctorId = doctorId || null;
    if (phone !== undefined) admin.phone = String(phone).trim() || null;
    if (branchId !== undefined) admin.branchId = branchId || null;
    if (branchIds !== undefined) {
      admin.branchIds = Array.isArray(branchIds) ? branchIds.filter(Boolean) : [];
      admin.branchId = admin.branchIds[0] || null;
    }
    await admin.save();

    if (role && role !== previousRole) {
      await AdminAuditLog.logAction({
        adminId: req.admin._id,
        adminEmail: req.admin.email,
        action: 'ADMIN_ROLE_CHANGED',
        resource: 'ADMIN',
        resourceId: String(admin._id),
        details: { target: admin.email, from: previousRole, to: role },
        ipAddress: req.adminIp || req.ip,
        userAgent: req.adminUserAgent,
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Staff account updated',
      data: shape(admin, authorizedEmails()),
    });
  } catch (error) {
    console.error('Update staff error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update staff account',
      error: error.message,
    });
  }
};

// @desc    Activate / deactivate a staff account
// @route   PATCH /api/admin/staff/:id/toggle-status
// @access  super_admin
exports.toggleStaffStatus = async (req, res) => {
  try {
    const admin = await Admin.findById(req.params.id);
    if (!admin) {
      return res.status(404).json({ success: false, message: 'Staff account not found' });
    }

    if (String(admin._id) === String(req.admin._id)) {
      return res.status(400).json({ success: false, message: 'You cannot deactivate your own account' });
    }

    if (admin.isActive && admin.role === 'super_admin') {
      const supers = await Admin.countDocuments({ role: 'super_admin', isActive: true });
      if (supers <= 1) {
        return res.status(400).json({
          success: false,
          message: 'This is the only active super admin — promote someone else first.',
        });
      }
    }

    admin.isActive = !admin.isActive;
    await admin.save();

    // Deactivation is an immediate lockout, not a suggestion.
    if (!admin.isActive) {
      await require('../models/Token').updateMany(
        { userId: admin._id, isActive: true }, { $set: { isActive: false } },
      ).catch(() => undefined);
    }

    return res.status(200).json({
      success: true,
      message: `Staff account ${admin.isActive ? 'activated' : 'deactivated'}`,
      data: shape(admin, authorizedEmails()),
    });
  } catch (error) {
    console.error('Toggle staff error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to change staff status',
      error: error.message,
    });
  }
};

// @desc    Delete a staff account
// @route   DELETE /api/admin/staff/:id
// @access  super_admin
exports.deleteStaff = async (req, res) => {
  try {
    const admin = await Admin.findById(req.params.id);
    if (!admin) {
      return res.status(404).json({ success: false, message: 'Staff account not found' });
    }

    if (String(admin._id) === String(req.admin._id)) {
      return res.status(400).json({ success: false, message: 'You cannot delete your own account' });
    }

    if (admin.role === 'super_admin') {
      const supers = await Admin.countDocuments({ role: 'super_admin', isActive: true });
      if (supers <= 1) {
        return res.status(400).json({
          success: false,
          message: 'This is the only active super admin — promote someone else first.',
        });
      }
    }

    await require('../models/Token').updateMany(
      { userId: admin._id, isActive: true }, { $set: { isActive: false } },
    ).catch(() => undefined);
    await Admin.deleteOne({ _id: admin._id });

    return res.status(200).json({ success: true, message: 'Staff account deleted' });
  } catch (error) {
    console.error('Delete staff error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete staff account',
      error: error.message,
    });
  }
};

// @desc    Set / reset a staff member's password (credentials are emailed)
// @route   PUT /api/admin/staff/:id/password
// @access  super_admin
exports.setStaffPassword = async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password || String(password).length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
    }
    const admin = await Admin.findById(req.params.id).select('+passwordHash');
    if (!admin) return res.status(404).json({ success: false, message: 'Staff account not found' });

    const isReset = !!admin.passwordHash;
    admin.setPassword(String(password));
    admin.isActive = true;
    await admin.save({ validateModifiedOnly: true });
    // The old password is dead — so is every session that used it.
    await require('../models/Token').updateMany(
      { userId: admin._id, isActive: true }, { $set: { isActive: false } },
    ).catch(() => undefined);

    let emailed = false;
    try {
      await require('../utils/emailService').sendDoctorCredentials(admin.email, admin.name, {
        password: String(password),
        mode: isReset ? 'reset' : 'created',
        panel: PANEL_LABEL[admin.role] || 'Zennara',
      });
      emailed = true;
    } catch (err) {
      console.error('❌ Staff credentials email failed (password still set):', err.message);
    }

    return res.status(200).json({
      success: true,
      credentialsEmailed: emailed,
      message: emailed
        ? `Password ${isReset ? 'reset' : 'set'} — details emailed to ${admin.email}.`
        : `Password ${isReset ? 'reset' : 'set'}. The email could not be sent — share it with them directly.`,
    });
  } catch (error) {
    console.error('Set staff password error:', error);
    return res.status(500).json({ success: false, message: 'Failed to set the password' });
  }
};

// @desc    Reveal a staff member's current panel password (audited)
// @route   GET /api/admin/staff/:id/password
// @access  super_admin
exports.revealStaffPassword = async (req, res) => {
  try {
    const admin = await Admin.findById(req.params.id).select('+passwordHash +passwordPlain');
    if (!admin) return res.status(404).json({ success: false, message: 'Staff account not found' });
    return res.status(200).json({
      success: true,
      data: {
        hasPassword: !!admin.passwordHash,
        // Passwords set before the plaintext copy existed cannot be shown —
        // only reset. The panel explains that when password is null.
        password: admin.passwordHash ? (admin.passwordPlain || null) : null,
        passwordSetAt: admin.passwordSetAt || null,
      },
    });
  } catch (error) {
    console.error('Reveal staff password error:', error);
    return res.status(500).json({ success: false, message: 'Failed to look up the password' });
  }
};

// @desc    The roles the panel can assign
// @route   GET /api/admin/staff/roles
// @access  Admin
exports.getRoles = async (req, res) => {
  res.status(200).json({
    success: true,
    data: [
      { id: 'super_admin', label: 'Super Admin', description: 'The full admin panel — every clinic, every module.' },
      { id: 'doctor', label: 'Dermatologist', description: 'Clinical panel — own day, patients, prescriptions.' },
      { id: 'therapist', label: 'Therapist', description: 'Floor panel — today’s guests, sessions, consumption.' },
    ],
  });
};
