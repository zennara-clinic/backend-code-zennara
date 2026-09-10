/**
 * Org-wide security switches, and the un-sticking of a locked-out colleague.
 *
 * Two things live here, both super-admin only:
 *
 *   · pausing the staff login rate limiter, for a bounded window, so a panel
 *     can be tested without waiting out a 15-minute lockout;
 *   · clearing one account's failed-attempt lock, which previously could only
 *     be waited out for an hour.
 *
 * Both are audited. The pause is always a deadline, never a boolean — see
 * models/SecuritySettings.js for why.
 */
const Admin = require('../models/Admin');
const AdminAuditLog = require('../models/AdminAuditLog');
const SecuritySettings = require('../models/SecuritySettings');
const { setLoginRateLimitPause } = require('../middleware/rateLimiter');
const logger = require('../utils/logger');

const view = (doc) => {
  const until = doc?.loginRateLimit?.pausedUntil ? new Date(doc.loginRateLimit.pausedUntil) : null;
  const active = Boolean(until && until.getTime() > Date.now());
  return {
    loginRateLimit: {
      /** True when the limiter is doing its job. The panel shows a banner when it is not. */
      active: !active,
      pausedUntil: active ? until.toISOString() : null,
      minutesRemaining: active ? Math.ceil((until.getTime() - Date.now()) / 60000) : 0,
      pausedByName: active ? doc.loginRateLimit.pausedByName : null,
      pausedReason: active ? doc.loginRateLimit.pausedReason : null,
      maxPauseMinutes: SecuritySettings.MAX_PAUSE_MINUTES,
    },
  };
};

// @desc    Current security switches
// @route   GET /api/admin/security-settings
// @access  super_admin
exports.get = async (req, res) => {
  try {
    return res.json({ success: true, data: view(await SecuritySettings.load()) });
  } catch (error) {
    logger.error('Security settings read failed', { error: error.message });
    return res.status(500).json({ success: false, message: 'Could not read the security settings.' });
  }
};

// @desc    Pause, extend or resume the staff login rate limiter
// @route   PATCH /api/admin/security-settings/login-rate-limit
// @access  super_admin
exports.setLoginRateLimit = async (req, res) => {
  try {
    const resume = req.body.paused === false;
    const minutes = Number(req.body.minutes);
    const reason = String(req.body.reason || '').trim();

    if (resume) {
      const doc = await SecuritySettings.findByIdAndUpdate(
        'security',
        { $set: { 'loginRateLimit.pausedUntil': null, 'loginRateLimit.pausedBy': null, 'loginRateLimit.pausedByName': null, 'loginRateLimit.pausedReason': null } },
        { new: true, upsert: true },
      ).lean();
      setLoginRateLimitPause(null);
      await AdminAuditLog.logAction({
        adminId: req.admin._id, adminEmail: req.admin.email,
        action: 'SETTINGS_UPDATED', resource: 'SECURITY',
        details: { setting: 'loginRateLimit', change: 'resumed' },
        ipAddress: req.adminIp || req.ip, userAgent: req.adminUserAgent,
      }).catch(() => {});
      logger.warn('Staff login rate limiter RESUMED', { by: req.admin.email });
      return res.json({ success: true, message: 'Login rate limiting is back on.', data: view(doc) });
    }

    if (!Number.isFinite(minutes) || minutes <= 0) {
      return res.status(400).json({ success: false, message: 'Choose how long to pause it for.' });
    }
    if (minutes > SecuritySettings.MAX_PAUSE_MINUTES) {
      return res.status(400).json({
        success: false,
        message: `The longest it can be paused for is ${SecuritySettings.MAX_PAUSE_MINUTES / 60} hours.`,
      });
    }
    /*
     * A reason is required. This switch turns off brute-force protection for
     * every staff account in the business; six months later someone will read
     * the audit line and need to know whether it was deliberate.
     */
    if (reason.length < 3) {
      return res.status(400).json({ success: false, message: 'Say why it is being paused — it goes in the audit log.' });
    }

    const until = new Date(Date.now() + minutes * 60 * 1000);
    const doc = await SecuritySettings.findByIdAndUpdate(
      'security',
      {
        $set: {
          'loginRateLimit.pausedUntil': until,
          'loginRateLimit.pausedBy': req.admin._id,
          'loginRateLimit.pausedByName': req.admin.name || req.admin.email,
          'loginRateLimit.pausedReason': reason,
        },
      },
      { new: true, upsert: true },
    ).lean();
    setLoginRateLimitPause(until);

    await AdminAuditLog.logAction({
      adminId: req.admin._id, adminEmail: req.admin.email,
      action: 'SETTINGS_UPDATED', resource: 'SECURITY',
      details: { setting: 'loginRateLimit', change: 'paused', minutes, until: until.toISOString(), reason },
      ipAddress: req.adminIp || req.ip, userAgent: req.adminUserAgent,
      status: 'WARNING',
    }).catch(() => {});
    logger.warn('Staff login rate limiter PAUSED', { by: req.admin.email, until: until.toISOString(), reason });

    return res.json({
      success: true,
      message: `Login rate limiting is off until ${until.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })}.`,
      data: view(doc),
    });
  } catch (error) {
    logger.error('Security settings update failed', { error: error.message });
    return res.status(500).json({ success: false, message: 'Could not change the setting.' });
  }
};

// @desc    Who is locked out right now
// @route   GET /api/admin/security-settings/locked-accounts
// @access  super_admin
exports.lockedAccounts = async (req, res) => {
  try {
    const rows = await Admin.find({
      $or: [
        { accountLockedUntil: { $gt: new Date() } },
        { failedLoginAttempts: { $gt: 0 } },
      ],
    })
      .select('name email role failedLoginAttempts accountLockedUntil')
      .sort({ accountLockedUntil: -1, failedLoginAttempts: -1 })
      .limit(50)
      .lean();

    return res.json({
      success: true,
      data: rows.map((a) => ({
        _id: a._id,
        name: a.name,
        email: a.email,
        role: a.role,
        failedLoginAttempts: a.failedLoginAttempts || 0,
        lockedUntil: a.accountLockedUntil && new Date(a.accountLockedUntil) > new Date()
          ? new Date(a.accountLockedUntil).toISOString()
          : null,
      })),
    });
  } catch (error) {
    logger.error('Locked account list failed', { error: error.message });
    return res.status(500).json({ success: false, message: 'Could not read the locked accounts.' });
  }
};

// @desc    Clear one account's failed attempts and lock
// @route   POST /api/admin/security-settings/unlock/:id
// @access  super_admin
exports.unlockAccount = async (req, res) => {
  try {
    const admin = await Admin.findById(req.params.id).select('name email failedLoginAttempts accountLockedUntil');
    if (!admin) return res.status(404).json({ success: false, message: 'Account not found.' });

    admin.failedLoginAttempts = 0;
    admin.accountLockedUntil = null;
    await admin.save({ validateModifiedOnly: true });

    await AdminAuditLog.logAction({
      adminId: req.admin._id, adminEmail: req.admin.email,
      action: 'SETTINGS_UPDATED', resource: 'SECURITY',
      resourceId: String(admin._id),
      details: { setting: 'accountLock', change: 'unlocked', account: admin.email },
      ipAddress: req.adminIp || req.ip, userAgent: req.adminUserAgent,
    }).catch(() => {});

    return res.json({ success: true, message: `${admin.name || admin.email} can sign in again.` });
  } catch (error) {
    logger.error('Account unlock failed', { error: error.message });
    return res.status(500).json({ success: false, message: 'Could not unlock the account.' });
  }
};
