/**
 * Held time on a provider's diary — the desk calendar's block-outs.
 *
 * Zenoti-sourced blocks are read-only here (they are owned by the mirror and
 * would reappear on the next sync). Panel blocks can be created, edited and
 * removed by staff with bookings.manage. Nothing here writes to Zenoti.
 */
const ProviderBlock = require('../models/ProviderBlock');
const Doctor = require('../models/Doctor');
const Branch = require('../models/Branch');
const { clinicDateTime, parseClockMinutes } = require('../utils/bookingTime');

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** GET /api/provider-blocks?from=YYYY-MM-DD&to=YYYY-MM-DD&branchId=&doctorId= */
exports.list = async (req, res) => {
  try {
    const { from, to, branchId, doctorId, includeInactive } = req.query;
    if (!from) return res.status(400).json({ success: false, message: 'from (YYYY-MM-DD) is required' });
    const start = clinicDateTime(from, '00:00');
    const end = clinicDateTime(to || from, '23:59');
    const filter = { date: { $gte: start, $lte: end } };
    if (includeInactive !== 'true') filter.active = true;
    if (branchId) filter.branchId = branchId;
    if (doctorId) filter.doctorId = String(doctorId).toLowerCase();
    const rows = await ProviderBlock.find(filter).sort({ date: 1, startTime: 1 }).lean();
    res.json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/** POST /api/provider-blocks — a desk block: { date, startTime, endTime, doctorId?, adminId?, branchId, title, notes } */
exports.create = async (req, res) => {
  try {
    const { date, startTime, endTime, doctorId, adminId, branchId, title, notes, color } = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return res.status(400).json({ success: false, message: 'date must be YYYY-MM-DD' });
    if (!HHMM.test(startTime || '') || !HHMM.test(endTime || '')) return res.status(400).json({ success: false, message: 'startTime and endTime must be HH:mm' });
    if (parseClockMinutes(endTime) <= parseClockMinutes(startTime)) return res.status(400).json({ success: false, message: 'endTime must be after startTime' });
    if (!doctorId && !adminId) return res.status(400).json({ success: false, message: 'Pick the provider (doctorId or adminId) the time is held for' });

    let providerName = '';
    if (doctorId) {
      const doc = await Doctor.findOne({ doctorId: String(doctorId).toLowerCase() }).select('name').lean();
      if (!doc) return res.status(404).json({ success: false, message: 'Dermatologist not found' });
      providerName = doc.name;
    }
    let branchName = '';
    if (branchId) {
      const b = await Branch.findById(branchId).select('name').lean();
      if (!b) return res.status(404).json({ success: false, message: 'Centre not found' });
      branchName = b.name;
    }
    const block = await ProviderBlock.create({
      source: 'panel',
      doctorId: doctorId ? String(doctorId).toLowerCase() : null,
      adminId: adminId || null,
      providerName,
      branchId: branchId || null,
      branchName,
      date: clinicDateTime(date, '00:00'),
      startTime, endTime,
      startAt: clinicDateTime(date, startTime),
      endAt: clinicDateTime(date, endTime),
      title: String(title || 'Blocked').trim().slice(0, 80),
      notes: String(notes || '').slice(0, 1000),
      color: color || null,
      createdByName: req.admin?.name || null,
      createdByAdminId: req.admin?._id || null,
      active: true,
    });
    res.status(201).json({ success: true, data: block });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/** PUT /api/provider-blocks/:id — edit a panel block. */
exports.update = async (req, res) => {
  try {
    const block = await ProviderBlock.findById(req.params.id);
    if (!block) return res.status(404).json({ success: false, message: 'Block not found' });
    if (block.source === 'zenoti') return res.status(400).json({ success: false, message: 'This block comes from Zenoti. Change it in Zenoti; it will update here on the next sync.' });
    const { startTime, endTime, title, notes, color, date } = req.body || {};
    const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
    if (startTime !== undefined) { if (!HHMM.test(startTime)) return res.status(400).json({ success: false, message: 'startTime must be HH:mm' }); block.startTime = startTime; }
    if (endTime !== undefined) { if (!HHMM.test(endTime)) return res.status(400).json({ success: false, message: 'endTime must be HH:mm' }); block.endTime = endTime; }
    if (parseClockMinutes(block.endTime) <= parseClockMinutes(block.startTime)) return res.status(400).json({ success: false, message: 'endTime must be after startTime' });
    if (day) block.date = clinicDateTime(day, '00:00');
    const key = day || new Date(block.date).toISOString().slice(0, 10);
    block.startAt = clinicDateTime(key, block.startTime);
    block.endAt = clinicDateTime(key, block.endTime);
    if (title !== undefined) block.title = String(title || 'Blocked').trim().slice(0, 80);
    if (notes !== undefined) block.notes = String(notes || '').slice(0, 1000);
    if (color !== undefined) block.color = color || null;
    await block.save();
    res.json({ success: true, data: block });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

/** DELETE /api/provider-blocks/:id — release a panel block (soft). */
exports.remove = async (req, res) => {
  try {
    const block = await ProviderBlock.findById(req.params.id);
    if (!block) return res.status(404).json({ success: false, message: 'Block not found' });
    if (block.source === 'zenoti') return res.status(400).json({ success: false, message: 'This block comes from Zenoti. Remove it in Zenoti; it will clear here on the next sync.' });
    block.active = false;
    await block.save();
    res.json({ success: true, data: block });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
