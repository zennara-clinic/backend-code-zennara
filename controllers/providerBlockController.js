/**
 * Zenoti-owned provider block-outs.
 *
 * The panel reads these live. Mutations are intentionally refused because the
 * current Zenoti API credentials expose no supported block-out write route;
 * accepting a local-only block would leave Zenoti free to sell the same time.
 */
const liveAvailability = require('../services/zenotiAvailabilityService');

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** GET /api/provider-blocks?from=YYYY-MM-DD&to=&branchId=&doctorId= */
exports.list = async (req, res) => {
  try {
    const { from, to, branchId, doctorId } = req.query;
    if (!DATE.test(String(from || '')) || !DATE.test(String(to || from || ''))) {
      return res.status(400).json({ success: false, message: 'from and to must be YYYY-MM-DD' });
    }
    const rows = await liveAvailability.providerBlocks({
      from,
      to: to || from,
      branchId: branchId || null,
      doctorId: doctorId || null,
    });
    return res.json({ success: true, count: rows.length, data: rows, source: 'zenoti-live' });
  } catch (error) {
    return res.status(error.status || 503).json({
      success: false,
      code: error.code || 'ZENOTI_AVAILABILITY_UNAVAILABLE',
      message: error.message || 'Could not load Zenoti block-outs.',
    });
  }
};

const rejectMutation = (_req, res) => res.status(409).json({
  success: false,
  code: 'ZENOTI_BLOCKOUT_PRIMARY',
  message: 'Manage block-outs, meetings and leave in Zenoti. This panel reads the result back live.',
});

exports.create = rejectMutation;
exports.update = rejectMutation;
exports.remove = rejectMutation;
