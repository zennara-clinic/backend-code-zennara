const Role = require('../models/Role');
const { sanitizePermissions } = require('../config/permissions');

/**
 * Seed a few starter role templates the first time the panel runs, so the
 * clinic has something to assign immediately. They are ordinary custom roles —
 * fully editable and deletable — not locked system roles. Seeding only happens
 * when the Role collection is empty, so it never fights the clinic's own edits.
 */
const STARTERS = [
  {
    key: 'receptionist',
    name: 'Receptionist',
    color: 'blue',
    description: 'Front desk — bookings, patients and check-in.',
    permissions: [
      'overview.view', 'today.view',
      'bookings.view', 'bookings.manage',
      'patients.view', 'patients.manage',
      'contactChanges.view', 'contactChanges.manage',
      'chat.view', 'chat.manage', 'support.view', 'support.manage',
      'services.view', 'dermatologists.view', 'therapists.view', 'packages.view',
    ],
  },
  {
    key: 'clinic-manager',
    name: 'Clinic manager',
    color: 'green',
    description: 'Runs the clinic day to day, without staff/role administration.',
    permissions: [
      'overview.view', 'today.view', 'analytics.view',
      'bookings.view', 'bookings.manage', 'patients.view', 'patients.manage',
      'contactChanges.view', 'contactChanges.manage', 'chat.view', 'chat.manage',
      'support.view', 'support.manage',
      'services.view', 'services.manage', 'categories.view', 'categories.manage',
      'dermatologists.view', 'therapists.view', 'packages.view', 'packages.manage',
      'consultationNotes.view',
      'products.view', 'coupons.view', 'coupons.manage', 'orders.view', 'orders.manage',
      'inventory.view', 'stockLedger.view', 'vendors.view',
      'branches.view', 'reviews.view', 'reviews.manage',
    ],
  },
  {
    key: 'inventory-manager',
    name: 'Inventory manager',
    color: 'amber',
    description: 'Stock, vendors and products.',
    permissions: [
      'overview.view',
      'products.view', 'products.manage', 'brands.view', 'brands.manage',
      'inventory.view', 'inventory.manage', 'stockLedger.view',
      'vendors.view', 'vendors.manage',
    ],
  },
];

async function seedRoles() {
  try {
    const count = await Role.estimatedDocumentCount();
    if (count > 0) return;
    await Role.insertMany(
      STARTERS.map((r) => ({ ...r, permissions: sanitizePermissions(r.permissions), isSystem: false })),
    );
    console.log(`🔐 Seeded ${STARTERS.length} starter role templates`);
  } catch (err) {
    console.error('⚠️  Role seeding skipped:', err.message);
  }
}

module.exports = { seedRoles };
