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

const ROLES = ['super_admin', 'doctor', 'therapist', 'staff'];

/**
 * Which account types this endpoint may create, and where the others come from.
 *
 * Only two are made here: `staff` from the Add-staff form, and `therapist` from
 * the Therapists page. The rest are deliberately unreachable, because each is
 * owned somewhere else and a second way to mint one would let the panel
 * contradict its source of truth:
 *
 *   super_admin — the server's ADMIN_EMAILS list. `Admin.resolveLogin` creates
 *                 the row on first sign-in, so the env file stays authoritative
 *                 and nobody can grant themselves everything from the UI.
 *   doctor      — POST /api/doctors, which creates the clinical profile and the
 *                 login together; a login with no profile behind it is useless.
 *
 * The same rule blocks promotion on update: an account cannot be moved onto a
 * type this endpoint could not have created.
 */
const CREATABLE_ROLES = ['staff', 'therapist'];
const ROLE_SOURCE = {
  super_admin: "Super admins come from the server's ADMIN_EMAILS list — add the address there and the account appears on their first sign-in.",
  doctor: 'Dermatologist logins are created on the Dermatologists page, together with the clinical profile they belong to.',
};
const { sanitizePermissions } = require('../config/permissions');

/**
 * How each account signs in.
 *
 * Admin-panel accounts (`super_admin`, `staff`) use email + a one-time code
 * emailed to that address — they have no password, and none can be set for
 * them. The dermatologist and floor panels use email + password, set here or
 * from the Dermatologists / Therapists pages. `PASSWORD_ROLES` is the same list
 * the login endpoints enforce (see controllers/adminAuthController.js).
 */
const PASSWORD_ROLES = ['doctor', 'therapist'];
const usesPassword = (role) => PASSWORD_ROLES.includes(role);
const PANEL_OF = (role) => (role === 'doctor' ? 'Dermatologist' : role === 'therapist' ? 'Therapist' : 'Admin');

const authorizedEmails = () =>
  (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

const PANEL_LABEL = { doctor: 'Dermatologist', therapist: 'Therapist', staff: 'Zennara' };

/**
 * Which staff roles a caller may see or change through these endpoints.
 *
 * The Therapists page is staff management too — it just manages one role, and
 * carries its own permission (`therapists.view` / `.manage` / `.password`)
 * rather than the blanket `staff.*` that unlocks every account including super
 * admins. Rather than duplicate the CRUD, the routes accept either permission
 * and this narrows the caller to the rows they were actually granted.
 *
 * Returns null when every role is in scope (super admin, or a `staff.*` holder),
 * or an array of the roles they may touch — empty meaning none.
 */
const SCOPED_BY_PERMISSION = { therapist: 'therapists', doctor: 'dermatologists' };

/*
 * Operational screens that must NAME clinical staff — the booking drawer's
 * "assign a therapist", the bookings filter, the chat assignee list — read this
 * route too. They are revealed by `bookings.*` / `chat.*`, not `staff.view`, so
 * without this they got a 403 on a list they legitimately need. They see only
 * dermatologist and therapist rows: the people work is assigned to, never a
 * super admin or another admin-panel account.
 */
const ASSIGNEE_PERMISSIONS = ['bookings.view', 'bookings.manage', 'chat.view', 'chat.manage', 'today.view', 'overview.view'];
const ASSIGNEE_ROLES = ['doctor', 'therapist'];

function rolesInScope(admin, verb) {
  if (!admin) return [];
  const held = admin.permissions instanceof Set ? admin.permissions : new Set();
  if (admin.isSuperAdmin || held.has(`staff.${verb}`)) return null;
  const scoped = Object.entries(SCOPED_BY_PERMISSION)
    .filter(([, area]) => held.has(`${area}.${verb}`))
    .map(([role]) => role);
  // Reading who to assign work to is a view-only concession; it never widens
  // what a role may change.
  if (verb === 'view' && ASSIGNEE_PERMISSIONS.some((p) => held.has(p))) {
    for (const r of ASSIGNEE_ROLES) if (!scoped.includes(r)) scoped.push(r);
  }
  return scoped;
}

/** 403 unless `role` is inside the caller's scope. Returns true when it answered. */
function refuseOutOfScope(req, res, role, verb) {
  const scope = rolesInScope(req.admin, verb);
  if (scope === null || scope.includes(role)) return false;
  res.status(403).json({
    success: false,
    message: 'You do not have permission to manage this kind of account.',
  });
  return true;
}

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
  // RBAC: assigned custom role + direct permission grants.
  customRoleId: admin.customRoleId || null,
  permissions: sanitizePermissions(admin.permissions),
  /*
   * Whether the current password can actually be shown. Passwords set before
   * the readable copy existed have only a bcrypt hash, which cannot be turned
   * back into the password — the panel says so up front rather than making
   * someone click "Show" to discover it.
   */
  passwordSetAt: admin.passwordSetAt || null,
  /** How this account gets in — the panel labels the row with it. */
  loginMethod: 'otp',
  /*
   * Whether sign-in will actually work today. Admin-panel accounts sign in with
   * an emailed code and `Admin.resolveLogin` accepts any active staff row, so
   * being active is enough — the ADMIN_EMAILS allow-list is only the bootstrap
   * for the first super admin, reported separately below. Clinical accounts
   * additionally need a password set.
   */
  canSignIn: admin.isActive !== false,
  onAllowList: allowList.includes(String(admin.email).toLowerCase()),
});

// @desc    List staff accounts
// @route   GET /api/admin/staff
// @access  Admin
exports.getStaff = async (req, res) => {
  try {
    const { role, search, isActive } = req.query;

    const filter = {};
    if (role) filter.role = role;

    // A caller who only holds `therapists.view` sees therapist rows, whatever
    // they asked for — the Therapists page and the Staff page share this route.
    const scope = rolesInScope(req.admin, 'view');
    if (scope !== null) {
      const visible = role ? scope.filter((r) => r === role) : scope;
      if (!visible.length) {
        return res.status(200).json({
          success: true,
          count: 0,
          data: [],
          stats: { total: 0, active: 0, byRole: ROLES.reduce((a, r) => ({ ...a, [r]: 0 }), {}) },
        });
      }
      filter.role = { $in: visible };
    }
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
    const { email, name, role, doctorId, phone, branchId, branchIds, password, customRoleId, permissions } = req.body;

    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ success: false, message: 'A valid email is required' });
    }
    if (!ROLES.includes(role)) {
      return res.status(400).json({ success: false, message: `Role must be one of: ${ROLES.join(', ')}` });
    }
    if (!CREATABLE_ROLES.includes(role)) {
      return res.status(400).json({
        success: false,
        message: ROLE_SOURCE[role] || 'This kind of account is not created here.',
      });
    }
    if (refuseOutOfScope(req, res, role, 'manage')) return;
    // Admin-panel accounts have no password — they sign in with an emailed code.
    // Accepting one here would create a second, unusable way in.
    if (password && !usesPassword(role)) {
      return res.status(400).json({
        success: false,
        message: 'Admin panel accounts sign in with a one-time code emailed to them — they do not get a password.',
      });
    }
    if (password && String(password).length < 8) {
      return res.status(400).json({ success: false, message: 'The password must be at least 8 characters' });
    }

    const existing = await Admin.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(400).json({ success: false, message: 'A staff account with this email already exists' });
    }

    // RBAC assignment only applies to admin-panel 'staff' accounts.
    const isPanelStaff = role === 'staff';

    const admin = await Admin.create({
      email: email.toLowerCase(),
      name: name || email.split('@')[0],
      role,
      doctorId: role === 'doctor' && doctorId ? doctorId : null,
      phone: phone ? String(phone).trim() : null,
      branchId: branchId || (Array.isArray(branchIds) && branchIds[0]) || null,
      branchIds: Array.isArray(branchIds) ? branchIds.filter(Boolean) : (branchId ? [branchId] : []),
      customRoleId: isPanelStaff && customRoleId ? customRoleId : null,
      permissions: isPanelStaff ? sanitizePermissions(permissions) : [],
      isActive: true,
    });

    const allowList = authorizedEmails();

    return res.status(201).json({
      success: true,
      message: `Account created — they sign in to the ${PANEL_OF(role)} panel with ${admin.email} and the code emailed at sign-in.`,
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
    if (role && role !== admin.role && !CREATABLE_ROLES.includes(role)) {
      return res.status(400).json({
        success: false,
        message: ROLE_SOURCE[role] || 'An account cannot be changed into this type here.',
      });
    }
    if (refuseOutOfScope(req, res, admin.role, 'manage')) return;
    if (role && refuseOutOfScope(req, res, role, 'manage')) return;

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
    const { phone, branchId, branchIds, customRoleId, permissions } = req.body;
    if (name !== undefined) admin.name = name;
    if (role !== undefined) admin.role = role;
    if (doctorId !== undefined) admin.doctorId = doctorId || null;
    if (phone !== undefined) admin.phone = String(phone).trim() || null;
    if (branchId !== undefined) admin.branchId = branchId || null;
    if (branchIds !== undefined) {
      admin.branchIds = Array.isArray(branchIds) ? branchIds.filter(Boolean) : [];
      admin.branchId = admin.branchIds[0] || null;
    }
    // RBAC assignment. Only 'staff' accounts carry a custom role / direct grants;
    // switching a staff member off the 'staff' role clears them to avoid stale
    // permissions lingering on a doctor/therapist/super_admin record.
    const effectiveRole = role !== undefined ? role : admin.role;
    if (effectiveRole === 'staff') {
      if (customRoleId !== undefined) admin.customRoleId = customRoleId || null;
      if (permissions !== undefined) admin.permissions = sanitizePermissions(permissions);
    } else {
      admin.customRoleId = null;
      admin.permissions = [];
    }
    // Moving an account onto an admin-panel role retires its password, so the
    // clinical panels cannot still be entered with the old credentials.
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
    if (refuseOutOfScope(req, res, admin.role, 'manage')) return;

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
    if (refuseOutOfScope(req, res, admin.role, 'manage')) return;

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



// @desc    The roles the panel can assign
// @route   GET /api/admin/staff/roles
// @access  Admin
exports.getRoles = async (req, res) => {
  res.status(200).json({
    success: true,
    data: [
      { id: 'staff', label: 'Staff', description: 'Admin panel, limited to an assigned role. Signs in with an emailed code. Created on the Staff page.' },
      { id: 'super_admin', label: 'Super Admin', description: 'The full admin panel — every clinic, every module. Signs in with an emailed code. Created from ADMIN_EMAILS.' },
      { id: 'doctor', label: 'Dermatologist', description: 'Clinical panel — own day, patients, prescriptions. Signs in with a password. Created on the Dermatologists page.' },
      { id: 'therapist', label: 'Therapist', description: 'Floor panel — today’s guests, sessions, consumption. Signs in with a password. Created on the Therapists page.' },
    ],
  });
};
