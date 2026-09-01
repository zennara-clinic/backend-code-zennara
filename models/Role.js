const mongoose = require('mongoose');
const { sanitizePermissions } = require('../config/permissions');

/**
 * A custom staff role — a named bundle of granular permissions the clinic
 * creates in the panel (e.g. "Front desk", "Inventory manager") and assigns to
 * staff accounts. Effective access for a staff member is the union of their
 * role's permissions and any direct grants on the account (see models/Admin.js
 * and middleware/auth.js `loadEffectivePermissions`).
 *
 * `isSystem` roles are seeded and cannot be deleted or have their key changed;
 * their permission set can still be edited by a super admin. super_admin is not
 * a Role here — it is a built-in that implicitly holds every permission.
 */
const RoleSchema = new mongoose.Schema(
  {
    // Stable, machine-friendly identifier. Immutable for system roles.
    key: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^[a-z0-9][a-z0-9_-]*$/, 'Use lowercase letters, numbers, hyphens or underscores'],
    },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },
    // Chip colour in the panel — a small palette keyword, validated loosely.
    color: { type: String, default: 'green', trim: true },
    permissions: {
      type: [String],
      default: [],
      set: sanitizePermissions,
    },
    isSystem: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.models.Role || mongoose.model('Role', RoleSchema);
