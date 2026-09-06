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
const PANEL_OF = (role) => (role === 'doctor' ? 'Dermatologist' : role === 'therapist' ? 'Therapist' : 'Admin');
const { sendStaffCredentials } = require('../utils/staffCredentials');
const Token = require('../models/Token');

/** Per-centre role rows from the panel: [{ branchId, roleId, kind, from, to, note }]. */
function validateAssignments(rows) {
  if (rows === undefined || rows === null) return null;
  if (!Array.isArray(rows)) return 'assignments must be a list';
  for (const r of rows) {
    if (!r || !r.branchId) return 'Every centre assignment needs a centre';
    if (r.kind && !['primary', 'deputation'].includes(r.kind)) return 'Assignment kind must be primary or deputation';
    if (r.kind === 'deputation' && !(r.from && r.to)) return 'A deputation needs a start and an end date';
    if (r.from && r.to && new Date(r.to) < new Date(r.from)) return 'An assignment cannot end before it starts';
  }
  return null;
}
function cleanAssignments(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.filter((r) => r && r.branchId).map((r) => ({
    branchId: r.branchId,
    roleId: r.roleId || null,
    kind: r.kind === 'deputation' ? 'deputation' : 'primary',
    from: r.from ? new Date(r.from) : null,
    to: r.to ? new Date(r.to) : null,
    note: String(r.note || '').slice(0, 300),
  }));
}

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
  hasPassword: Boolean(admin.passwordSetAt),
  mustChangePassword: Boolean(admin.mustChangePassword),
  /** How this account gets in — the panel labels the row with it. */
  loginMethod: admin.passwordSetAt ? 'password' : 'otp',
  loginMethods: admin.passwordSetAt ? ['password', 'otp'] : ['otp'],
  jobTitle: admin.jobTitle || null,
  assignments: (admin.assignments || []).map((a) => ({
    branchId: a.branchId, roleId: a.roleId || null, kind: a.kind || 'primary', from: a.from || null, to: a.to || null, note: a.note || '',
  })),
  terminatedAt: admin.terminatedAt || null,
  terminationReason: admin.terminationReason || null,
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
    const {
      email, name, role, doctorId, phone, branchId, branchIds, password, customRoleId, permissions,
      jobTitle, assignments, generatePassword, notify,
    } = req.body;

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
    if (password && String(password).length < Admin.PASSWORD_MIN) {
      return res.status(400).json({ success: false, message: `The password must be at least ${Admin.PASSWORD_MIN} characters` });
    }

    const existing = await Admin.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(400).json({ success: false, message: 'A staff account with this email already exists' });
    }

    // RBAC assignment only applies to admin-panel 'staff' accounts.
    const isPanelStaff = role === 'staff';
    const assignmentsErr = validateAssignments(assignments);
    if (assignmentsErr) return res.status(400).json({ success: false, message: assignmentsErr });

    const admin = new Admin({
      email: email.toLowerCase(),
      name: name || email.split('@')[0],
      role,
      jobTitle: jobTitle ? String(jobTitle).trim() : null,
      doctorId: role === 'doctor' && doctorId ? doctorId : null,
      phone: phone ? String(phone).trim() : null,
      branchId: branchId || (Array.isArray(branchIds) && branchIds[0]) || null,
      branchIds: Array.isArray(branchIds) ? branchIds.filter(Boolean) : (branchId ? [branchId] : []),
      customRoleId: isPanelStaff && customRoleId ? customRoleId : null,
      permissions: isPanelStaff ? sanitizePermissions(permissions) : [],
      assignments: cleanAssignments(assignments),
      isActive: true,
    });
    // Optional password at creation: the given one, or a generated temporary
    // one the person must change. Without either they sign in with the code.
    let issued = null;
    if (password || generatePassword) {
      issued = password || Admin.generateTemporaryPassword();
      await admin.setPassword(issued, { setBy: req.admin._id, mustChange: Boolean(generatePassword) || Boolean(req.body.mustChangePassword) });
    }
    await admin.save();

    const allowList = authorizedEmails();
    const delivery = issued ? await sendStaffCredentials(admin, { password: issued, mode: 'created', channel: notify || 'email' }) : null;

    return res.status(201).json({
      success: true,
      message: issued
        ? `Account created — they sign in to the ${PANEL_OF(role)} panel with ${admin.email} and the password${delivery?.email === 'sent' ? ' emailed to them' : ''}.`
        : `Account created — they sign in to the ${PANEL_OF(role)} panel with ${admin.email} and the code emailed at sign-in.`,
      data: shape(admin, allowList),
      // Shown once to the administrator who created it; never stored in clear.
      temporaryPassword: generatePassword ? issued : undefined,
      delivery,
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
    const { phone, branchId, branchIds, customRoleId, permissions, email } = req.body;

    /*
     * The email IS the login now (the one-time code is sent to it), so it has
     * to be changeable here — an auto-onboarded therapist starts with a
     * placeholder address. A change ends every open session for the account:
     * whoever holds the old address must sign in again from the new one.
     */
    let emailChanged = false;
    if (email !== undefined) {
      const next = String(email || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(next)) {
        return res.status(400).json({ success: false, message: 'Enter a valid email address' });
      }
      if (next !== admin.email) {
        if (await Admin.exists({ email: next, _id: { $ne: admin._id } })) {
          return res.status(409).json({ success: false, message: 'That email already belongs to another staff login' });
        }
        admin.email = next;
        admin.sessionVersion = (admin.sessionVersion || 1) + 1;
        emailChanged = true;
      }
    }
    if (name !== undefined) admin.name = name;
    if (role !== undefined) admin.role = role;
    if (doctorId !== undefined) admin.doctorId = doctorId || null;
    if (phone !== undefined) admin.phone = String(phone).trim() || null;
    if (req.body.jobTitle !== undefined) admin.jobTitle = req.body.jobTitle ? String(req.body.jobTitle).trim() : null;
    if (req.body.assignments !== undefined) {
      const bad = validateAssignments(req.body.assignments);
      if (bad) return res.status(400).json({ success: false, message: bad });
      admin.assignments = cleanAssignments(req.body.assignments);
    }
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
    if (emailChanged) {
      await Token.updateMany({ userId: admin._id, userType: 'Admin', isActive: true }, { $set: { isActive: false } }).catch(() => {});
    }

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

/* ------------------------------------------------------------------------- *
 * Password, credentials, clone, terminate — Zenoti's Edit Employee actions.
 * ------------------------------------------------------------------------- */

/**
 * @desc  Set or reset a staff member's password (Zenoti "Update Password").
 * @route PUT /api/admin/staff/:id/password
 * body: { password?, generate?, mustChange?, notify: 'email'|'whatsapp'|'both'|'none' }
 * Only the hash is stored. A generated temporary password is returned ONCE to
 * the administrator and optionally sent to the person.
 */
exports.setStaffPassword = async (req, res) => {
  try {
    const admin = await Admin.findById(req.params.id).select('+passwordHash');
    if (!admin) return res.status(404).json({ success: false, message: 'Staff account not found' });
    if (refuseOutOfScope(req, res, admin.role, 'manage')) return;
    const { password, generate, mustChange, notify } = req.body || {};
    const issued = generate || !password ? Admin.generateTemporaryPassword() : String(password);
    try {
      await admin.setPassword(issued, { setBy: req.admin._id, mustChange: generate || !password ? true : Boolean(mustChange) });
    } catch (err) {
      return res.status(err.status || 400).json({ success: false, message: err.message });
    }
    admin.failedLoginAttempts = 0;
    admin.accountLockedUntil = null;
    await admin.save({ validateModifiedOnly: true });
    await Token.updateMany({ userId: admin._id, userType: 'Admin', isActive: true }, { $set: { isActive: false } }).catch(() => {});
    const mode = admin.passwordSetAt ? 'reset' : 'created';
    const delivery = await sendStaffCredentials(admin, { password: issued, mode, channel: notify || 'none' });
    await AdminAuditLog.logAction({
      adminId: req.admin._id, adminEmail: req.admin.email, action: 'SETTINGS_UPDATED', resource: 'ADMIN',
      resourceId: String(admin._id), details: { field: 'password', target: admin.email, generated: Boolean(generate || !password), notify: notify || 'none', delivery },
      ipAddress: req.adminIp || req.ip, userAgent: req.adminUserAgent,
    }).catch(() => {});
    return res.json({
      success: true,
      message: 'Password set. Every previous session for this account has been signed out.',
      data: shape(admin, authorizedEmails()),
      temporaryPassword: generate || !password ? issued : undefined,
      delivery,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to set the password', error: error.message });
  }
};

/**
 * @desc  Send sign-in details (Zenoti "Reset Password: send username and password").
 * @route POST /api/admin/staff/:id/send-credentials   body: { channel: 'email'|'whatsapp'|'both' }
 * Always issues a fresh temporary password (a stored one cannot be read back).
 */
exports.sendStaffCredentials = async (req, res) => {
  try {
    const admin = await Admin.findById(req.params.id).select('+passwordHash');
    if (!admin) return res.status(404).json({ success: false, message: 'Staff account not found' });
    if (refuseOutOfScope(req, res, admin.role, 'manage')) return;
    const channel = ['email', 'whatsapp', 'both'].includes(req.body?.channel) ? req.body.channel : 'email';
    if (channel !== 'email' && !admin.phone) {
      return res.status(400).json({ success: false, message: 'This account has no phone number — add one first, or send by email.' });
    }
    const issued = Admin.generateTemporaryPassword();
    await admin.setPassword(issued, { setBy: req.admin._id, mustChange: true });
    admin.failedLoginAttempts = 0;
    admin.accountLockedUntil = null;
    await admin.save({ validateModifiedOnly: true });
    await Token.updateMany({ userId: admin._id, userType: 'Admin', isActive: true }, { $set: { isActive: false } }).catch(() => {});
    const delivery = await sendStaffCredentials(admin, { password: issued, mode: 'reset', channel });
    await AdminAuditLog.logAction({
      adminId: req.admin._id, adminEmail: req.admin.email, action: 'SETTINGS_UPDATED', resource: 'ADMIN',
      resourceId: String(admin._id), details: { field: 'credentials-sent', target: admin.email, channel, delivery },
      ipAddress: req.adminIp || req.ip, userAgent: req.adminUserAgent,
    }).catch(() => {});
    const sentSomewhere = delivery.email === 'sent' || delivery.whatsapp === 'sent';
    return res.json({
      success: true,
      message: sentSomewhere ? 'Sign-in details sent. They will be asked to choose their own password.' : 'Could not deliver the details; the temporary password is shown here once.',
      data: shape(admin, authorizedEmails()),
      temporaryPassword: sentSomewhere ? undefined : issued,
      delivery,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to send sign-in details', error: error.message });
  }
};

/**
 * @desc  Clone an account's access onto a new person (Zenoti "Clone").
 * @route POST /api/admin/staff/:id/clone   body: { email, name?, phone? }
 * Copies role, job title, custom role, direct grants, centres and assignments.
 * Never copies the password or the doctor link.
 */
exports.cloneStaff = async (req, res) => {
  try {
    const source = await Admin.findById(req.params.id).lean();
    if (!source) return res.status(404).json({ success: false, message: 'Staff account not found' });
    if (!CREATABLE_ROLES.includes(source.role)) {
      return res.status(400).json({ success: false, message: `${PANEL_OF(source.role)} accounts of this type are created on their own page; only staff and therapist accounts can be cloned here.` });
    }
    if (refuseOutOfScope(req, res, source.role, 'manage')) return;
    const { email, name, phone } = req.body || {};
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ success: false, message: 'A valid email for the new account is required' });
    if (await Admin.exists({ email: String(email).toLowerCase() })) return res.status(400).json({ success: false, message: 'A staff account with this email already exists' });
    const admin = await Admin.create({
      email: String(email).toLowerCase(),
      name: name || String(email).split('@')[0],
      phone: phone ? String(phone).trim() : null,
      role: source.role,
      jobTitle: source.jobTitle || null,
      branchId: source.branchId || null,
      branchIds: source.branchIds || [],
      customRoleId: source.customRoleId || null,
      permissions: sanitizePermissions(source.permissions || []),
      assignments: (source.assignments || []).filter((a) => a.kind !== 'deputation'),
      isActive: true,
    });
    await AdminAuditLog.logAction({
      adminId: req.admin._id, adminEmail: req.admin.email, action: 'ADMIN_CREATED', resource: 'ADMIN',
      resourceId: String(admin._id), details: { clonedFrom: source.email, target: admin.email },
      ipAddress: req.adminIp || req.ip, userAgent: req.adminUserAgent,
    }).catch(() => {});
    return res.status(201).json({ success: true, message: `Cloned ${source.email}'s access onto ${admin.email}`, data: shape(admin, authorizedEmails()) });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to clone the account', error: error.message });
  }
};

/**
 * @desc  End employment (Zenoti "Terminate"): dated, with a reason, sessions ended.
 * @route POST /api/admin/staff/:id/terminate   body: { reason, effectiveAt? }
 * Deactivate is reversible and undated; terminate records when and why.
 */
exports.terminateStaff = async (req, res) => {
  try {
    const admin = await Admin.findById(req.params.id);
    if (!admin) return res.status(404).json({ success: false, message: 'Staff account not found' });
    if (refuseOutOfScope(req, res, admin.role, 'manage')) return;
    if (String(admin._id) === String(req.admin._id)) return res.status(400).json({ success: false, message: 'You cannot terminate your own account' });
    if (admin.role === 'super_admin') {
      const supers = await Admin.countDocuments({ role: 'super_admin', isActive: true });
      if (supers <= 1) return res.status(400).json({ success: false, message: 'This is the only active super admin — promote someone else first.' });
    }
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 3) return res.status(400).json({ success: false, message: 'A reason is required' });
    const effectiveAt = req.body?.effectiveAt ? new Date(req.body.effectiveAt) : new Date();
    if (Number.isNaN(effectiveAt.getTime())) return res.status(400).json({ success: false, message: 'effectiveAt is not a valid date' });

    admin.terminatedAt = effectiveAt;
    admin.terminationReason = reason;
    admin.terminatedBy = req.admin._id;
    // A future date keeps the login until then; today or earlier ends it now.
    if (effectiveAt <= new Date()) {
      admin.isActive = false;
      admin.sessionVersion = (admin.sessionVersion || 1) + 1;
      await Token.updateMany({ userId: admin._id, isActive: true }, { $set: { isActive: false } }).catch(() => {});
      // A dermatologist who has left should stop being offered in the app.
      if (admin.role === 'doctor' && admin.doctorId) {
        await require('../models/Doctor').updateOne({ _id: admin.doctorId }, { $set: { isActive: false, onlineBookingEnabled: false } }).catch(() => {});
      }
    }
    await admin.save({ validateModifiedOnly: true });
    await AdminAuditLog.logAction({
      adminId: req.admin._id, adminEmail: req.admin.email, action: 'ADMIN_DEACTIVATED', resource: 'ADMIN',
      resourceId: String(admin._id), details: { target: admin.email, terminated: true, effectiveAt, reason },
      ipAddress: req.adminIp || req.ip, userAgent: req.adminUserAgent,
    }).catch(() => {});
    return res.json({ success: true, message: effectiveAt <= new Date() ? 'Employment ended; sign-in is blocked.' : `Employment ends on ${effectiveAt.toISOString().slice(0, 10)}.`, data: shape(admin, authorizedEmails()) });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to terminate the account', error: error.message });
  }
};
