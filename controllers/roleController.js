const Role = require('../models/Role');
const Admin = require('../models/Admin');
const { GROUPS, sanitizePermissions } = require('../config/permissions');

/**
 * Roles & permissions (RBAC) for admin-panel staff.
 *
 * The catalog endpoint feeds the panel's role editor so it always offers exactly
 * the permissions the server enforces. CRUD manages custom role bundles;
 * assignment to individual staff lives in staffController (customRoleId +
 * permissions on the Admin record).
 */

const shapeRole = (role, inUse) => ({
  _id: role._id,
  key: role.key,
  name: role.name,
  description: role.description || '',
  color: role.color || 'green',
  permissions: sanitizePermissions(role.permissions),
  isSystem: !!role.isSystem,
  isActive: role.isActive !== false,
  staffCount: typeof inUse === 'number' ? inUse : undefined,
  createdAt: role.createdAt,
  updatedAt: role.updatedAt,
});

// @desc    The permission catalog (groups + keys) the panel renders
// @route   GET /api/admin/roles/catalog
// @access  roles.view
exports.getCatalog = async (_req, res) => {
  res.json({ success: true, data: { groups: GROUPS } });
};

// @desc    List custom roles with how many staff use each
// @route   GET /api/admin/roles
// @access  roles.view
exports.getRoles = async (_req, res) => {
  try {
    const roles = await Role.find({}).sort({ isSystem: -1, name: 1 }).lean();
    const counts = await Admin.aggregate([
      { $match: { customRoleId: { $ne: null } } },
      { $group: { _id: '$customRoleId', n: { $sum: 1 } } },
    ]);
    const byId = new Map(counts.map((c) => [String(c._id), c.n]));
    res.json({ success: true, data: roles.map((r) => shapeRole(r, byId.get(String(r._id)) || 0)) });
  } catch (error) {
    console.error('List roles error:', error);
    res.status(500).json({ success: false, message: 'Failed to load roles' });
  }
};

// @desc    Create a custom role
// @route   POST /api/admin/roles
// @access  roles.manage
exports.createRole = async (req, res) => {
  try {
    const { name, description, color, permissions } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, message: 'A role name is required' });
    }
    // Derive a stable key from the name; ensure it is unique.
    const base = String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'role';
    let key = base;
    for (let i = 2; await Role.exists({ key }); i += 1) key = `${base}-${i}`;

    const role = await Role.create({
      key,
      name: String(name).trim(),
      description: description ? String(description).trim() : '',
      color: color ? String(color).trim() : 'green',
      permissions: sanitizePermissions(permissions),
      isSystem: false,
      createdBy: req.admin?._id || null,
    });
    res.status(201).json({ success: true, message: 'Role created', data: shapeRole(role, 0) });
  } catch (error) {
    console.error('Create role error:', error);
    res.status(500).json({ success: false, message: 'Failed to create the role' });
  }
};

// @desc    Update a role (name, description, colour, permissions)
// @route   PUT /api/admin/roles/:id
// @access  roles.manage
exports.updateRole = async (req, res) => {
  try {
    const role = await Role.findById(req.params.id);
    if (!role) return res.status(404).json({ success: false, message: 'Role not found' });

    const { name, description, color, permissions, isActive } = req.body || {};
    if (name !== undefined && String(name).trim()) role.name = String(name).trim();
    if (description !== undefined) role.description = String(description || '').trim();
    if (color !== undefined) role.color = String(color || 'green').trim();
    if (permissions !== undefined) role.permissions = sanitizePermissions(permissions);
    // System roles are always available to assign; only custom roles toggle.
    if (isActive !== undefined && !role.isSystem) role.isActive = !!isActive;

    await role.save();
    const inUse = await Admin.countDocuments({ customRoleId: role._id });
    res.json({ success: true, message: 'Role updated', data: shapeRole(role, inUse) });
  } catch (error) {
    console.error('Update role error:', error);
    res.status(500).json({ success: false, message: 'Failed to update the role' });
  }
};

// @desc    Delete a custom role (system roles and in-use roles are protected)
// @route   DELETE /api/admin/roles/:id
// @access  roles.manage
exports.deleteRole = async (req, res) => {
  try {
    const role = await Role.findById(req.params.id);
    if (!role) return res.status(404).json({ success: false, message: 'Role not found' });
    if (role.isSystem) {
      return res.status(400).json({ success: false, message: 'System roles cannot be deleted' });
    }
    const inUse = await Admin.countDocuments({ customRoleId: role._id });
    if (inUse > 0) {
      return res.status(400).json({
        success: false,
        message: `This role is assigned to ${inUse} staff member${inUse === 1 ? '' : 's'}. Reassign them first.`,
      });
    }
    await role.deleteOne();
    res.json({ success: true, message: 'Role deleted' });
  } catch (error) {
    console.error('Delete role error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete the role' });
  }
};
