/**
 * Permission catalog — the single source of truth for admin-panel RBAC.
 *
 * A "permission" is a granular capability string like `bookings.manage`. Custom
 * roles (see models/Role.js) are named bundles of these strings, and individual
 * staff accounts can carry extra direct grants. The backend enforces them with
 * requirePermission() (see middleware/auth.js); the admin panel mirrors the same
 * keys to show/hide nav and controls. The panel also fetches this catalog
 * (GET /api/admin/roles/catalog) so the role editor always lists exactly what
 * the server understands — front and back can never drift on which permissions
 * exist.
 *
 * Convention: most areas expose `<area>.view` (see the page / read its data) and
 * `<area>.manage` (create/edit/delete). A few carry an extra sensitive verb
 * (e.g. `.password`, `.bank`, `.refund`) so a role can read a page without the
 * sensitive action. `.manage` does NOT imply `.view`; assign both when a role
 * should both see and edit — the catalog groups them together to make that easy.
 *
 * super_admin is not represented here: it implicitly holds every permission and
 * bypasses the checks entirely. Removing super_admin's blanket access is out of
 * scope — this system governs the non-super staff roles created in the panel.
 */

/**
 * Groups map 1:1 to the sidebar sections so the role editor reads like the panel
 * the staff member will actually use. Each permission has a key, a human label,
 * and an optional `sensitive` flag the editor highlights.
 */
const GROUPS = [
  {
    key: 'home',
    label: 'Home',
    permissions: [
      { key: 'overview.view', label: 'Overview dashboard' },
      { key: 'today.view', label: "Today's schedule" },
      { key: 'analytics.view', label: 'Analytics & reports' },
    ],
  },
  {
    key: 'operations',
    label: 'Operations',
    permissions: [
      { key: 'bookings.view', label: 'View bookings' },
      { key: 'bookings.manage', label: 'Create / edit / cancel bookings' },
      { key: 'patients.view', label: 'View patients' },
      { key: 'patients.manage', label: 'Edit patient records' },
      { key: 'patients.delete', label: 'Delete / restore patient accounts', sensitive: true },
      { key: 'contactChanges.view', label: 'View contact-change requests' },
      { key: 'contactChanges.manage', label: 'Approve / reject contact changes' },
      { key: 'chat.view', label: 'View chat' },
      { key: 'chat.manage', label: 'Reply in chat' },
      { key: 'support.view', label: 'View support inbox' },
      { key: 'support.manage', label: 'Respond to support messages' },
    ],
  },
  {
    key: 'care',
    label: 'Care',
    permissions: [
      { key: 'services.view', label: 'View services' },
      { key: 'services.manage', label: 'Edit services' },
      { key: 'categories.view', label: 'View categories' },
      { key: 'categories.manage', label: 'Edit categories' },
      { key: 'dermatologists.view', label: 'View dermatologists' },
      { key: 'dermatologists.manage', label: 'Edit dermatologists & schedules' },
      { key: 'dermatologists.password', label: 'Set / view dermatologist passwords', sensitive: true },
      { key: 'therapists.view', label: 'View therapists' },
      { key: 'therapists.manage', label: 'Edit therapists' },
      { key: 'therapists.password', label: 'Set / view therapist passwords', sensitive: true },
      { key: 'packages.view', label: 'View packages' },
      { key: 'packages.manage', label: 'Edit & assign packages' },
      { key: 'consultationNotes.view', label: 'View consultation notes' },
      { key: 'consultationNotes.manage', label: 'Delete consultation notes', sensitive: true },
    ],
  },
  {
    key: 'commerce',
    label: 'Commerce',
    permissions: [
      { key: 'products.view', label: 'View products' },
      { key: 'products.manage', label: 'Edit products' },
      { key: 'brands.view', label: 'View brands & formulations' },
      { key: 'brands.manage', label: 'Edit brands & formulations' },
      { key: 'coupons.view', label: 'View coupons' },
      { key: 'coupons.manage', label: 'Edit coupons' },
      { key: 'orders.view', label: 'View orders' },
      { key: 'orders.manage', label: 'Update order status / fulfil' },
      { key: 'orders.refund', label: 'Issue refunds', sensitive: true },
    ],
  },
  {
    key: 'stock',
    label: 'Stock',
    permissions: [
      { key: 'inventory.view', label: 'View inventory' },
      { key: 'inventory.manage', label: 'Adjust inventory' },
      { key: 'stockLedger.view', label: 'View stock ledger' },
      { key: 'vendors.view', label: 'View vendors' },
      { key: 'vendors.manage', label: 'Edit vendors' },
      { key: 'vendors.bank', label: 'Reveal vendor bank details', sensitive: true },
    ],
  },
  {
    key: 'appStudio',
    label: 'App studio',
    permissions: [
      { key: 'appStudio.view', label: 'View app studio' },
      { key: 'appStudio.manage', label: 'Edit app home, control & content' },
      { key: 'banners.manage', label: 'Manage banners' },
      { key: 'announcements.manage', label: 'Manage announcements' },
      { key: 'appContent.manage', label: 'Edit consultation page, membership, copy & legal' },
    ],
  },
  {
    key: 'zenoti',
    label: 'Zenoti / CRM',
    permissions: [
      { key: 'zenoti.view', label: 'View Zenoti data' },
      { key: 'zenoti.manage', label: 'Run Zenoti sync & admin actions', sensitive: true },
    ],
  },
  {
    key: 'administration',
    label: 'Organisation & staff',
    permissions: [
      { key: 'branches.view', label: 'View branches' },
      { key: 'branches.manage', label: 'Edit branches', sensitive: true },
      { key: 'reviews.view', label: 'View reviews' },
      { key: 'reviews.manage', label: 'Moderate reviews' },
      { key: 'staff.view', label: 'View staff accounts' },
      { key: 'staff.manage', label: 'Create / edit staff accounts', sensitive: true },
      { key: 'staff.password', label: 'Set / view staff passwords', sensitive: true },
      { key: 'roles.view', label: 'View roles & permissions' },
      { key: 'roles.manage', label: 'Create / edit roles & assign permissions', sensitive: true },
      { key: 'audit.view', label: 'View the audit log', sensitive: true },
    ],
  },
];

/**
 * Baseline permissions the built-in non-admin roles implicitly hold.
 *
 * `doctor` and `therapist` accounts are never given a custom role — their
 * access is the panel they sign into. But the dermatologist and floor panels
 * call the same REST endpoints as the admin panel, and those endpoints are now
 * gated with requirePermission(). Without a baseline their permission set is
 * empty, so every gated call their own panel makes answers 403. These lists are
 * exactly what those panels need — nothing wider — and they are unioned in by
 * middleware/auth.js `computeEffectivePermissions`.
 *
 * They are deliberately NOT part of the catalog: the role editor only assigns
 * permissions to admin-panel `staff` accounts, and these are not assignable.
 */
const ROLE_BASELINES = {
  doctor: [
    // Their day, their patients, and the consult room.
    'bookings.view', 'bookings.manage',
    'patients.view', 'patients.manage',
    'consultationNotes.view', 'consultationNotes.manage',
    'services.view', 'packages.view', 'branches.view',
    // Their own profile, schedule and fee requests live behind these.
    'dermatologists.view',
    // The prescription pad reads the product catalogue; PatientDetail reads the
    // app's membership copy; the CRM tab reads a guest's clinic history.
    'products.view', 'appStudio.view', 'zenoti.view',
  ],
  therapist: [
    // The floor: today's guests, check-in/out, and stock consumed in session.
    'bookings.view', 'bookings.manage',
    'patients.view',
    'inventory.view', 'inventory.manage',
    'services.view', 'packages.view', 'branches.view',
    // The session screen reads the app's service copy, and shows what the
    // dermatologist prescribed for this guest.
    'appStudio.view', 'consultationNotes.view',
  ],
};

/** The implicit permissions a built-in role carries (empty for everyone else). */
const baselinePermissions = (role) => ROLE_BASELINES[String(role || '')] || [];

// Flat list of every valid permission key, and a fast membership set.
const ALL_PERMISSIONS = GROUPS.flatMap((g) => g.permissions.map((p) => p.key));
const PERMISSION_SET = new Set(ALL_PERMISSIONS);

/** Keep only strings that name a real permission — silently drops stale keys. */
function sanitizePermissions(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const key = String(raw || '').trim();
    if (PERMISSION_SET.has(key) && !seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

const isValidPermission = (key) => PERMISSION_SET.has(String(key || '').trim());

module.exports = {
  GROUPS,
  ROLE_BASELINES,
  baselinePermissions,
  ALL_PERMISSIONS,
  PERMISSION_SET,
  sanitizePermissions,
  isValidPermission,
};
