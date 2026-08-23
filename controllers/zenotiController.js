/**
 * Zenoti read endpoints for the signed-in customer.
 *
 * Every handler is scoped to `req.user` and only ever reads that user's own
 * Zenoti guest record — a customer can never request another guest's data. The
 * API key stays server-side; the client only sees normalised, PII-scoped data.
 */

const User = require('../models/User');
const Booking = require('../models/Booking');
const ProductOrder = require('../models/ProductOrder');
const zenoti = require('../services/zenotiService');
const zenotiSync = require('../services/zenotiSyncService');
const zenotiWrite = require('../services/zenotiWriteService');
const logger = require('../utils/logger');

/**
 * Resolve the signed-in user's Zenoti guest id (+ home center id, needed by the
 * memberships endpoint), or send a helpful error. Returns null when not linked.
 */
async function requireLinkedGuest(req, res) {
  if (!zenoti.isConfigured()) {
    res.status(503).json({ success: false, message: 'Zenoti integration is not configured.' });
    return null;
  }
  const user = await User.findById(req.user._id).select('zenotiGuestId zenotiCenterId');
  if (!user?.zenotiGuestId) {
    res.status(404).json({
      success: false,
      code: 'NOT_LINKED',
      message: 'This account is not linked to a Zenoti profile.',
    });
    return null;
  }
  return { guestId: user.zenotiGuestId, centerId: user.zenotiCenterId || null };
}

// @desc    Full Zenoti profile for the signed-in guest
// @route   GET /api/zenoti/profile
// @access  Private
exports.getProfile = async (req, res) => {
  try {
    const linked = await requireLinkedGuest(req, res);
    if (!linked) return;
    const { guestId } = linked;
    const guest = await zenoti.getGuest(guestId);
    if (!guest) return res.status(404).json({ success: false, message: 'Guest not found in Zenoti.' });
    const { _raw, ...safe } = guest; // never leak the raw CRM record
    res.status(200).json({ success: true, data: safe });
  } catch (error) {
    logger.error('Zenoti getProfile failed', { error: error.message });
    res.status(502).json({ success: false, message: 'Could not fetch your Zenoti profile right now.' });
  }
};

// @desc    Appointment / treatment history from Zenoti
// @route   GET /api/zenoti/appointments?from=YYYY-MM-DD&to=YYYY-MM-DD
// @access  Private
exports.getAppointments = async (req, res) => {
  try {
    const linked = await requireLinkedGuest(req, res);
    if (!linked) return;
    const { guestId } = linked;
    const { from, to } = req.query;
    const appointments = await zenoti.getGuestAppointments(guestId, { from, to });
    res.status(200).json({ success: true, data: appointments, count: appointments.length });
  } catch (error) {
    logger.error('Zenoti getAppointments failed', { error: error.message });
    res.status(502).json({ success: false, message: 'Could not fetch your appointment history right now.' });
  }
};

// @desc    Product / retail purchase history from Zenoti
// @route   GET /api/zenoti/orders
// @access  Private
exports.getOrders = async (req, res) => {
  try {
    const linked = await requireLinkedGuest(req, res);
    if (!linked) return;
    const { guestId } = linked;
    const products = await zenoti.getGuestProducts(guestId);
    res.status(200).json({ success: true, data: products, count: products.length });
  } catch (error) {
    logger.error('Zenoti getOrders failed', { error: error.message });
    res.status(502).json({ success: false, message: 'Could not fetch your purchase history right now.' });
  }
};

// @desc    Membership history from Zenoti
// @route   GET /api/zenoti/memberships
// @access  Private
exports.getMemberships = async (req, res) => {
  try {
    const linked = await requireLinkedGuest(req, res);
    if (!linked) return;
    const { guestId, centerId } = linked;
    const memberships = await zenoti.getGuestMemberships(guestId, centerId);
    res.status(200).json({ success: true, data: memberships, count: memberships.length });
  } catch (error) {
    logger.error('Zenoti getMemberships failed', { error: error.message });
    res.status(502).json({ success: false, message: 'Could not fetch your memberships right now.' });
  }
};

// @desc    Series / day packages (treatment package entitlements) from Zenoti
// @route   GET /api/zenoti/packages
// @access  Private
exports.getPackages = async (req, res) => {
  try {
    const linked = await requireLinkedGuest(req, res);
    if (!linked) return;
    const { guestId } = linked;
    const packages = await zenoti.getGuestPackages(guestId);
    res.status(200).json({ success: true, data: packages, count: packages.length });
  } catch (error) {
    logger.error('Zenoti getPackages failed', { error: error.message });
    res.status(502).json({ success: false, message: 'Could not fetch your packages right now.' });
  }
};

// @desc    Everything in one call — profile + history — for the app's clinic-history screen
// @route   GET /api/zenoti/overview
// @access  Private
exports.getOverview = async (req, res) => {
  try {
    const linked = await requireLinkedGuest(req, res);
    if (!linked) return;
    const { guestId } = linked;

    // Profile first so we know the guest's home center (memberships needs it).
    const profile = await zenoti.getGuest(guestId).catch(() => null);
    const centerId = linked.centerId || profile?.centerId || null;

    // The rest in parallel; tolerate individual failures so one missing section
    // doesn't blank the whole screen.
    const [appointments, orders, memberships, packages] = await Promise.all([
      zenoti.getGuestAppointments(guestId).catch(() => []),
      zenoti.getGuestProducts(guestId).catch(() => []),
      zenoti.getGuestMemberships(guestId, centerId).catch(() => []),
      zenoti.getGuestPackages(guestId).catch(() => []),
    ]);

    const safeProfile = profile ? (({ _raw, ...rest }) => rest)(profile) : null;
    res.status(200).json({
      success: true,
      data: { profile: safeProfile, appointments, orders, memberships, packages },
    });
  } catch (error) {
    logger.error('Zenoti getOverview failed', { error: error.message });
    res.status(502).json({ success: false, message: 'Could not fetch your clinic data right now.' });
  }
};

// @desc    Force a re-sync of the local mirror from Zenoti
// @route   POST /api/zenoti/sync
// @access  Private
exports.sync = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user?.zenotiGuestId) {
      return res.status(404).json({ success: false, code: 'NOT_LINKED', message: 'This account is not linked to a Zenoti profile.' });
    }
    await zenotiSync.syncLinkedUser(user);
    res.status(200).json({ success: true, message: 'Profile synced from Zenoti.' });
  } catch (error) {
    logger.error('Zenoti sync failed', { error: error.message });
    res.status(502).json({ success: false, message: 'Could not sync from Zenoti right now.' });
  }
};

/* --------------------------- Write-back (Phase 2) -------------------------- */

// @desc    Current write-back mode + this account's guest-link status
// @route   GET /api/zenoti/write-status
// @access  Private
exports.getWriteStatus = async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .select('zenotiGuestId zenotiSyncStatus zenotiSyncError source')
      .lean();
    res.status(200).json({
      success: true,
      data: {
        mode: zenotiWrite.mode(), // off | dryrun | live
        guest: {
          linked: Boolean(user?.zenotiGuestId),
          status: user?.zenotiSyncStatus || null,
          error: user?.zenotiSyncError || null,
        },
      },
    });
  } catch (error) {
    logger.error('Zenoti getWriteStatus failed', { error: error.message });
    res.status(500).json({ success: false, message: 'Could not read write status.' });
  }
};

// @desc    Ensure the signed-in user has a Zenoti guest (create/link)
// @route   POST /api/zenoti/ensure-guest
// @access  Private
exports.ensureGuest = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    const guestId = await zenotiWrite.ensureGuest(user);
    res.status(200).json({
      success: true,
      data: { zenotiGuestId: guestId, mode: zenotiWrite.mode(), status: user.zenotiSyncStatus },
      message: guestId ? 'Linked to Zenoti guest.' : `No live write performed (mode: ${zenotiWrite.mode()}).`,
    });
  } catch (error) {
    logger.error('Zenoti ensureGuest failed', { error: error.message });
    res.status(502).json({ success: false, message: 'Could not create/link your Zenoti guest right now.' });
  }
};

// @desc    Re-push one of the signed-in user's bookings to Zenoti
// @route   POST /api/zenoti/bookings/:id/resync
// @access  Private
exports.resyncBooking = async (req, res) => {
  try {
    const booking = await Booking.findOne({ _id: req.params.id, userId: req.user._id }).select('_id');
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
    await zenotiWrite.syncBooking(booking._id);
    const fresh = await Booking.findById(booking._id).select('zenotiAppointmentId zenotiSyncStatus zenotiSyncError').lean();
    res.status(200).json({ success: true, data: { mode: zenotiWrite.mode(), ...fresh } });
  } catch (error) {
    logger.error('Zenoti resyncBooking failed', { error: error.message });
    res.status(502).json({ success: false, message: 'Could not push this booking to Zenoti right now.' });
  }
};

/* ------------------------- Admin / panel (staff) -------------------------- */

// @desc    Staff view of ANY customer's full Zenoti data, for the admin panel.
//          Authorised clinic staff only — the legitimate way to inspect a
//          customer's records (no customer-app impersonation involved).
// @route   GET /api/admin/zenoti/overview?phone=&email=&guestId=
// @access  Admin (protectAdmin)
exports.adminGuestOverview = async (req, res) => {
  try {
    if (!zenoti.isConfigured()) {
      return res.status(503).json({ success: false, message: 'Zenoti integration is not configured.' });
    }
    const { phone, email, guestId } = req.query;

    let gid = guestId;
    if (!gid) {
      const guest = phone
        ? await zenoti.findGuestByPhone(phone)
        : email
        ? await zenoti.findGuestByEmail(email)
        : null;
      if (!guest) {
        return res.status(404).json({
          success: false,
          message: 'No Zenoti guest found for that phone/email.',
        });
      }
      gid = guest.zenotiGuestId;
    }

    // Profile first so we know the guest's home center (memberships needs it).
    const profile = await zenoti.getGuest(gid).catch(() => null);
    const centerId = profile?.centerId || null;

    const [appointments, orders, memberships, packages, notes, forms] = await Promise.all([
      zenoti.getGuestAppointments(gid).catch(() => []),
      zenoti.getGuestProducts(gid).catch(() => []),
      zenoti.getGuestMemberships(gid, centerId).catch(() => []),
      zenoti.getGuestPackages(gid).catch(() => []),
      zenoti.getGuestNotes(gid).catch(() => []),
      zenoti.getGuestForms(gid).catch(() => []),
    ]);

    const safeProfile = profile ? (({ _raw, ...rest }) => rest)(profile) : null;
    logger.info('Admin viewed Zenoti customer data', { adminId: req.admin?._id, guestId: gid });
    res.status(200).json({
      success: true,
      data: { guestId: gid, profile: safeProfile, appointments, orders, memberships, packages, notes, forms },
    });
  } catch (error) {
    logger.error('Admin Zenoti overview failed', { error: error.message });
    res.status(502).json({ success: false, message: 'Could not fetch this customer\'s Zenoti data right now.' });
  }
};

// @desc    Re-push one of the signed-in user's orders to Zenoti
// @route   POST /api/zenoti/orders/:id/resync
// @access  Private
exports.resyncOrder = async (req, res) => {
  try {
    const order = await ProductOrder.findOne({ _id: req.params.id, userId: req.user._id }).select('_id');
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    await zenotiWrite.syncOrder(order._id);
    const fresh = await ProductOrder.findById(order._id).select('zenotiInvoiceId zenotiSyncStatus zenotiSyncError').lean();
    res.status(200).json({ success: true, data: { mode: zenotiWrite.mode(), ...fresh } });
  } catch (error) {
    logger.error('Zenoti resyncOrder failed', { error: error.message });
    res.status(502).json({ success: false, message: 'Could not push this order to Zenoti right now.' });
  }
};
