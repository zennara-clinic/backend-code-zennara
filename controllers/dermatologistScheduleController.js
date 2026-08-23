/**
 * Availability for dermatologist consultations.
 *
 * Two audiences:
 *   · the panel reads and writes the schedule — the weekly pattern and the
 *     date overrides a dermatologist manages from their calendar
 *   · the app reads derived slots — it never sees the pattern, only the
 *     concrete times it may offer, each flagged booked or free
 *
 * The app deliberately gets no write path here. A patient takes a slot by
 * paying for it, and that happens in the payment controller where the slot can
 * be re-checked against the diary at the moment money is captured.
 */
const Doctor = require('../models/Doctor');
const DermatologistSchedule = require('../models/DermatologistSchedule');
const { SESSION_SLOT_MINUTES } = require('../config/scheduling');
const {
  slotsForDate,
  availabilityRange,
  anySlotsForDate,
  anyAvailabilityRange,
  whoIsFreeWithBranches,
  dateKey,
} = require('../utils/dermatologistSlots');

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

const fail = (res, code, message) => res.status(code).json({ success: false, message });

/**
 * May this admin edit this dermatologist's calendar?
 *
 * Admins and super admins can edit anyone's. A dermatologist can edit their
 * own and nobody else's — their Admin login is matched to their Doctor profile
 * by email, which is the only link between the two collections.
 */
async function canEdit(req, doctorId) {
  const role = req.admin?.role;
  if (role === 'super_admin' || role === 'admin') return true;
  if (role !== 'doctor') return false;
  const mine = await require('../utils/doctorIdentity').resolveDoctorForAdmin(req);
  return !!mine && mine.doctorId === doctorId;
}

/** Reject a payload before it can half-write a broken week. */
function validate(body) {
  const errors = [];

  if (body.leadTimeHours != null) {
    const n = Number(body.leadTimeHours);
    if (!Number.isFinite(n) || n < 0 || n > 720) errors.push('leadTimeHours must be between 0 and 720');
  }
  if (body.horizonDays != null) {
    const n = Number(body.horizonDays);
    if (!Number.isFinite(n) || n < 1 || n > 365) errors.push('horizonDays must be between 1 and 365');
  }

  const checkRanges = (ranges, where) => {
    (ranges || []).forEach((r, i) => {
      const s = DermatologistSchedule.toMinutes(r.start);
      const e = DermatologistSchedule.toMinutes(r.end);
      if (s === null || e === null) errors.push(`${where} range ${i + 1}: times must be HH:mm`);
      // A range that ends before it starts silently produces no slots, which
      // looks like "the save didn't work" rather than a mistake in the form.
      else if (e <= s) errors.push(`${where} range ${i + 1}: end must be after start`);
    });
  };

  (body.weekly || []).forEach((w, i) => {
    if (!Number.isInteger(w.day) || w.day < 0 || w.day > 6) errors.push(`weekly ${i + 1}: day must be 0–6`);
    checkRanges(w.ranges, `weekly ${i + 1}`);
  });

  const seen = new Set();
  (body.overrides || []).forEach((o, i) => {
    if (!DATE_KEY.test(String(o.date || ''))) errors.push(`override ${i + 1}: date must be YYYY-MM-DD`);
    // Two overrides on one date make the winner depend on array order.
    else if (seen.has(o.date)) errors.push(`override ${i + 1}: ${o.date} is listed twice`);
    else seen.add(o.date);
    if (!o.unavailable) checkRanges(o.ranges, `override ${o.date || i + 1}`);
  });

  return errors;
}

/** GET /api/dermatologists/:doctorId/schedule — panel. */
exports.getSchedule = async (req, res) => {
  try {
    const { doctorId } = req.params;

    const doctor = await Doctor.findOne({ doctorId }).select('doctorId name tier branch availableCentres').lean();
    if (!doctor) return fail(res, 404, 'Dermatologist not found');

    const schedule = await DermatologistSchedule.findOne({ doctorId }).lean();

    return res.json({
      success: true,
      data: {
        dermatologist: doctor,
        // A dermatologist nobody has configured yet gets a blank week rather
        // than a 404, so the panel can render the editor instead of an error.
        schedule: schedule
          ? { ...schedule, slotMinutes: SESSION_SLOT_MINUTES, configured: true }
          : DermatologistSchedule.blank(doctorId),
        canEdit: await canEdit(req, doctorId),
      },
    });
  } catch (error) {
    console.error('getSchedule error:', error);
    return fail(res, 500, 'Could not load the schedule');
  }
};

/** PUT /api/dermatologists/:doctorId/schedule — panel. */
exports.updateSchedule = async (req, res) => {
  try {
    const { doctorId } = req.params;

    const doctor = await Doctor.findOne({ doctorId }).select('doctorId').lean();
    if (!doctor) return fail(res, 404, 'Dermatologist not found');

    if (!(await canEdit(req, doctorId))) {
      return fail(res, 403, 'You can only edit your own availability');
    }

    const errors = validate(req.body || {});
    if (errors.length) {
      return res.status(400).json({ success: false, message: 'Invalid schedule', errors });
    }

    const update = {
      doctorId,
      slotMinutes: SESSION_SLOT_MINUTES,
      updatedBy: req.admin?._id || null,
    };
    ['leadTimeHours', 'horizonDays', 'isActive'].forEach((k) => {
      if (req.body[k] !== undefined) update[k] = req.body[k];
    });
    if (req.body.weekly !== undefined) {
      // Drop rows with no ranges — an empty day means "not working", which is
      // the absence of a row, not a row saying nothing.
      update.weekly = (req.body.weekly || []).filter((w) => w.ranges?.length);
    }
    if (req.body.overrides !== undefined) {
      update.overrides = (req.body.overrides || []).filter((o) => o.unavailable || o.ranges?.length || o.note);
    }

    const schedule = await DermatologistSchedule.findOneAndUpdate(
      { doctorId },
      update,
      { new: true, upsert: true, setDefaultsOnInsert: true, runValidators: true },
    ).lean();

    return res.json({
      success: true,
      message: 'Availability updated',
      data: { ...schedule, slotMinutes: SESSION_SLOT_MINUTES, configured: true },
    });
  } catch (error) {
    console.error('updateSchedule error:', error);
    return fail(res, 500, 'Could not save the schedule');
  }
};

/**
 * GET /api/dermatologists/:doctorId/availability?from=&to=&branchId= — app
 * and panel. Day-level states for painting a calendar.
 */
exports.getAvailability = async (req, res) => {
  try {
    const { doctorId } = req.params;
    const { branchId } = req.query;

    const from = DATE_KEY.test(req.query.from || '') ? req.query.from : dateKey(new Date());
    let to = req.query.to;
    if (!DATE_KEY.test(to || '')) {
      const d = new Date();
      d.setDate(d.getDate() + 60);
      to = dateKey(d);
    }

    const result = await availabilityRange(doctorId, from, to, { branchId: branchId || null });
    return res.json({ success: true, data: result });
  } catch (error) {
    console.error('getAvailability error:', error);
    return fail(res, 500, 'Could not load availability');
  }
};

/**
 * GET /api/dermatologists/:doctorId/slots?date=&branchId= — app and panel.
 * Every slot on one date, each flagged booked, too soon, or free.
 */
exports.getSlots = async (req, res) => {
  try {
    const { doctorId } = req.params;
    const { date, branchId } = req.query;

    if (!DATE_KEY.test(date || '')) return fail(res, 400, 'date is required as YYYY-MM-DD');

    const result = await slotsForDate(doctorId, date, { branchId: branchId || null });
    return res.json({ success: true, data: result });
  } catch (error) {
    console.error('getSlots error:', error);
    return fail(res, 500, 'Could not load slots');
  }
};

/*
 * ---------------------------------------------------------------------------
 * "Any available dermatologist"
 *
 * Time first, person second: the patient says when suits them and we say who
 * can see them. These deliberately sit above the /:doctorId routes so "any" is
 * never read as somebody's slug.
 * ------------------------------------------------------------------------ */

/** GET /api/dermatologists/any/availability?from=&to=&branchId=&branch= */
exports.getAnyAvailability = async (req, res) => {
  try {
    const { branchId, branch } = req.query;

    const from = DATE_KEY.test(req.query.from || '') ? req.query.from : dateKey(new Date());
    let to = req.query.to;
    if (!DATE_KEY.test(to || '')) {
      const d = new Date();
      d.setDate(d.getDate() + 60);
      to = dateKey(d);
    }

    const result = await anyAvailabilityRange(from, to, {
      branchId: branchId || null,
      branchName: branch || null,
    });
    return res.json({ success: true, data: result });
  } catch (error) {
    console.error('getAnyAvailability error:', error);
    return fail(res, 500, 'Could not load availability');
  }
};

/** GET /api/dermatologists/any/slots?date=&branchId=&branch= */
exports.getAnySlots = async (req, res) => {
  try {
    const { date, branchId, branch } = req.query;
    if (!DATE_KEY.test(date || '')) return fail(res, 400, 'date is required as YYYY-MM-DD');

    const result = await anySlotsForDate(date, {
      branchId: branchId || null,
      branchName: branch || null,
    });
    return res.json({ success: true, data: result });
  } catch (error) {
    console.error('getAnySlots error:', error);
    return fail(res, 500, 'Could not load slots');
  }
};

/**
 * GET /api/dermatologists/any/free?date=&time=&branchId=&branch=
 *
 * Who can take this exact slot. Re-asked on the selection screen rather than
 * trusting what the time picker returned, because the answer ages the moment
 * it is given.
 */
exports.getFreeDermatologists = async (req, res) => {
  try {
    const { date, time, branchId, branch } = req.query;
    if (!DATE_KEY.test(date || '')) return fail(res, 400, 'date is required as YYYY-MM-DD');
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(time || '')) {
      return fail(res, 400, 'time is required as HH:mm');
    }

    const matches = await whoIsFreeWithBranches(date, time, {
      branchId: branchId || null,
      branchName: branch || null,
    });
    const doctorIds = [...new Set(matches.map((match) => match.doctorId))];

    return res.json({ success: true, data: { date, time, doctorIds, matches } });
  } catch (error) {
    console.error('getFreeDermatologists error:', error);
    return fail(res, 500, 'Could not load dermatologists');
  }
};
