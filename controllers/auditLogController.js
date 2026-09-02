const AdminAuditLog = require('../models/AdminAuditLog');
const { clinicDayEnd, clinicDayStart } = require('../utils/bookingTime');

/**
 * Read side of the audit trail.
 *
 * Entries are written by the `auditLog` middleware on sensitive routes; this
 * controller only exposes them to the panel's Audit log page, plus a small
 * write endpoint so the panel can record decisions the middleware cannot see
 * (a cancellation reason typed by reception, for instance).
 */

// @desc    List audit entries
// @route   GET /api/admin/audit-logs
// @access  Admin
exports.getAuditLogs = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      action,
      resource,
      status,
      adminEmail,
      search,
      startDate,
      endDate,
    } = req.query;

    const filter = {};
    if (action) filter.action = action;
    if (resource) filter.resource = resource;
    if (status) filter.status = status;
    if (adminEmail) filter.adminEmail = adminEmail.toLowerCase();

    if (startDate || endDate) {
      filter.timestamp = {};
      // Clinic days on both ends — a UTC server otherwise drops the last
      // 5h30m of the chosen day, hiding that evening's entries.
      if (startDate) filter.timestamp.$gte = clinicDayStart(startDate);
      if (endDate) {
        const end = clinicDayEnd(endDate);
        filter.timestamp.$lte = end;
      }
    }

    if (search) {
      const rx = new RegExp(String(search).trim(), 'i');
      filter.$or = [{ adminEmail: rx }, { action: rx }, { resource: rx }, { resourceId: rx }];
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const perPage = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));

    const [logs, total] = await Promise.all([
      AdminAuditLog.find(filter)
        .sort({ timestamp: -1 })
        .skip((pageNum - 1) * perPage)
        .limit(perPage)
        .lean(),
      AdminAuditLog.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      count: logs.length,
      data: logs,
      pagination: {
        currentPage: pageNum,
        totalPages: Math.ceil(total / perPage) || 1,
        total,
      },
    });
  } catch (error) {
    console.error('Get audit logs error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch audit logs',
      error: error.message,
    });
  }
};

// @desc    Distinct action / resource values, for the filter menus
// @route   GET /api/admin/audit-logs/actions
// @access  Admin
exports.getAuditFilters = async (req, res) => {
  try {
    const [actions, resources, admins] = await Promise.all([
      AdminAuditLog.distinct('action'),
      AdminAuditLog.distinct('resource'),
      AdminAuditLog.distinct('adminEmail'),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        actions: actions.sort(),
        resources: resources.sort(),
        admins: admins.sort(),
      },
    });
  } catch (error) {
    console.error('Get audit filters error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch audit filters',
      error: error.message,
    });
  }
};

// @desc    Record an entry the route middleware cannot capture on its own
// @route   POST /api/admin/audit-logs
// @access  Admin
exports.createAuditLog = async (req, res) => {
  try {
    const { action, resource = 'SETTINGS', resourceId = null, details = {}, status = 'SUCCESS' } = req.body;

    if (!action) {
      return res.status(400).json({ success: false, message: 'action is required' });
    }

    const log = await AdminAuditLog.logAction({
      adminId: req.admin._id,
      adminEmail: req.admin.email,
      action,
      resource,
      resourceId,
      details,
      ipAddress: req.adminIp || req.ip,
      userAgent: req.adminUserAgent,
      status,
    });

    if (!log) {
      // logAction swallows its own errors so a failed write never breaks the
      // action being audited — surface it here since logging *is* the request.
      return res.status(400).json({
        success: false,
        message: `Could not record "${action}" — check the action and resource are recognised values.`,
      });
    }

    return res.status(201).json({ success: true, data: log });
  } catch (error) {
    console.error('Create audit log error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to record audit entry',
      error: error.message,
    });
  }
};

// @desc    Recent failed / suspicious activity
// @route   GET /api/admin/audit-logs/suspicious
// @access  Admin
exports.getSuspicious = async (req, res) => {
  try {
    const hours = parseInt(req.query.hours, 10) || 24;
    const data = await AdminAuditLog.getSuspiciousActivities(hours);
    return res.status(200).json({ success: true, count: data.length, data });
  } catch (error) {
    console.error('Get suspicious activity error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch suspicious activity',
      error: error.message,
    });
  }
};
