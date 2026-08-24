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

const shape = (admin, allowList) => ({
  _id: admin._id,
  email: admin.email,
  name: admin.name,
  role: admin.role,
  isActive: admin.isActive,
  isVerified: admin.isVerified,
  lastLogin: admin.lastLogin,
  createdAt: admin.createdAt,
  doctorId: admin.doctorId || null,
  /** False when the address is missing from ADMIN_EMAILS — login would fail. */
  canSignIn: allowList.includes(String(admin.email).toLowerCase()),
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

    const admins = await Admin.find(filter).sort({ role: 1, name: 1 }).lean();
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
    const { email, name, role, doctorId } = req.body;

    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ success: false, message: 'A valid email is required' });
    }
    if (!ROLES.includes(role)) {
      return res.status(400).json({ success: false, message: `Role must be one of: ${ROLES.join(', ')}` });
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
      isActive: true,
    });

    const allowList = authorizedEmails();
    const canSignIn = allowList.includes(admin.email);

    return res.status(201).json({
      success: true,
      message: canSignIn
        ? 'Staff account created'
        : `Staff account created. Add ${admin.email} to ADMIN_EMAILS on the server before they can sign in.`,
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
    if (name !== undefined) admin.name = name;
    if (role !== undefined) admin.role = role;
    if (doctorId !== undefined) admin.doctorId = doctorId || null;
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
