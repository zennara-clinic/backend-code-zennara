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
      // Reception opens the pre-consultation form a patient filled and may
      // PREPARE a prescription. It cannot sign one — prescriptions.sign is
      // deliberately absent, and the server refuses the Completed transition
      // without it (see consultationNoteController.saveNote).
      'forms.view', 'consultationNotes.view', 'prescriptions.draft',
      // Checkout and payment questions at the desk.
      'orders.view', 'orders.manage',
    ],
  },
  {
    key: 'branch-admin',
    name: 'Branch admin',
    color: 'green',
    description: 'Runs one centre day to day — operations, not clinic-wide configuration.',
    permissions: [
      'overview.view', 'today.view', 'analytics.view',
      'bookings.view', 'bookings.manage', 'patients.view', 'patients.manage',
      'contactChanges.view', 'contactChanges.manage',
      'chat.view', 'chat.manage', 'support.view', 'support.manage',
      'services.view', 'categories.view', 'packages.view', 'packages.manage',
      'dermatologists.view', 'therapists.view',
      'forms.view', 'consultationNotes.view',
      'products.view', 'orders.view', 'orders.manage', 'coupons.view',
      'inventory.view', 'stockLedger.view', 'purchaseOrders.view',
      'branches.view', 'reviews.view', 'reviews.manage',
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
  {
    key: 'pharmacist',
    name: 'Pharmacist / stores',
    color: 'amber',
    description: 'Dispensing and procurement — products, purchase orders, goods receipt.',
    permissions: [
      'overview.view',
      'products.view', 'products.manage', 'brands.view', 'brands.manage',
      'inventory.view', 'inventory.manage', 'inventory.availability',
      'inventory.receive', 'stockLedger.view',
      'purchaseOrders.view', 'purchaseOrders.manage',
      'vendors.view', 'vendors.manage',
      // Bulk product loading is part of running the stores, but importing
      // overwrites the catalogue, so it is granted knowingly rather than by
      // default. Vendor BANK details are not here: paying a vendor is a
      // finance decision, not a stores one.
      'bulk.export',
    ],
  },
];

/**
 * Insert any starter role the clinic does not already have.
 *
 * This used to bail out entirely once ANY role existed, which meant a clinic
 * that had been running for a week never received a starter added later — the
 * new Branch admin and Pharmacist templates would have been invisible on every
 * existing install.
 *
 * Matching is by `key`, and an existing role is never touched: if the clinic
 * has edited its Receptionist, that edit stands. Only genuinely absent
 * templates are added.
 */
async function seedRoles() {
  try {
    const existing = await Role.find({}).select('key').lean();
    const have = new Set(existing.map((r) => r.key));
    const missing = STARTERS.filter((r) => !have.has(r.key));
    if (!missing.length) return;

    await Role.insertMany(
      missing.map((r) => ({ ...r, permissions: sanitizePermissions(r.permissions), isSystem: false })),
    );
    console.log(`🔐 Seeded ${missing.length} starter role template(s): ${missing.map((r) => r.name).join(', ')}`);
  } catch (err) {
    console.error('⚠️  Role seeding skipped:', err.message);
  }
}

module.exports = { seedRoles };
