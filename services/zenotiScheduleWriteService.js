/**
 * Panel working hours → Zenoti employee shifts.
 *
 * Zenoti's slot engine only offers times inside a "Working" shift, and the
 * clinic does not publish shifts, so nothing booked in the app could ever be
 * written into Zenoti's diary. This publishes each linked, live dermatologist's
 * panel hours (DermatologistSchedule, clipped to centre hours) as Working
 * shifts, per centre and clinic day, over the booking horizon.
 *
 * Rules that keep the clinic's own roster safe:
 *   - only employees linked to an ACTIVE app dermatologist;
 *   - only days/centres where Zenoti has NO Working shift (NotScheduled or
 *     nothing) — a shift the clinic set is never edited or removed;
 *   - one new shift per doctor/centre/day (schedule_id '' = add; the existing
 *     NotScheduled row carries a template id shared across staff and is left
 *     alone);
 *   - never a leave/blockout, never a deletion.
 * Idempotent: a day that already has a Working shift is skipped.
 */
const zenoti = require('./zenotiService');
const { liveWrite, isLive, mode } = require('./zenotiWriteService');
const { CENTERS, clinicCenterIdForBranch } = require('../config/zenoti');
const { rangesFor, clampToBranch } = require('../utils/dermatologistSlots');
const logger = require('../utils/logger');

const istDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const HORIZON_DAYS = Math.max(1, Number(process.env.ZENOTI_PUBLISH_HOURS_DAYS) || 21);
let running = false;

function enabled() {
  return String(process.env.ZENOTI_PUBLISH_DOCTOR_HOURS || 'true').toLowerCase() !== 'false';
}

/** What we would publish: one entry per doctor/centre/day with the panel span. */
async function planDoctorHours({ days = HORIZON_DAYS, doctorId = null } = {}) {
  const Doctor = require('../models/Doctor');
  const DermatologistSchedule = require('../models/DermatologistSchedule');
  const Branch = require('../models/Branch');
  const ZenotiPractitioner = require('../models/ZenotiPractitioner');
  const doctors = await Doctor.find({ isActive: { $ne: false }, ...(doctorId ? { doctorId } : {}) }).select('doctorId name availableCentres').lean();
  const links = await ZenotiPractitioner.find({ active: true, onboardedDoctorId: { $in: doctors.map((d) => d.doctorId) } }).lean();
  const linkByDoctor = new Map(links.map((l) => [l.onboardedDoctorId, l]));
  const branches = await Branch.find({ isActive: true });
  const branchByName = new Map(branches.map((b) => [b.name, b]));
  const plan = [];
  for (const doctor of doctors) {
    const link = linkByDoctor.get(doctor.doctorId);
    if (!link) continue;
    const schedule = await DermatologistSchedule.findOne({ doctorId: doctor.doctorId }).lean();
    if (!schedule || schedule.isActive === false) continue;
    const centres = (doctor.availableCentres || []).map((name) => branchByName.get(name)).filter(Boolean);
    for (let i = 0; i < days; i += 1) {
      const day = istDay(Date.now() + i * 864e5);
      const resolved = rangesFor(schedule, day);
      if (!resolved.ranges.length) continue;
      // A doctor at several centres whose hours name no centre would be
      // published as Working everywhere at once. Zenoti needs one centre per
      // shift, so those days are held back until the panel hours say where.
      const branchless = resolved.perBranch ? resolved.perBranch.every((r) => !r.branchId) : !resolved.branchId;
      if (centres.length > 1 && branchless) { plan.push({ doctorId: doctor.doctorId, doctorName: doctor.name, date: day, ambiguousCentre: true }); continue; }
      for (const branch of centres) {
        const centerId = clinicCenterIdForBranch(branch.name);
        if (!centerId || !CENTERS[centerId]?.isClinic) continue;
        // Ranges for this centre: per-branch weekly rows, or branch-less ones.
        let ranges = resolved.ranges;
        if (resolved.perBranch) {
          const mine = resolved.perBranch.filter((r) => !r.branchId || String(r.branchId) === String(branch._id)).flatMap((r) => r.ranges);
          ranges = mine;
        } else if (resolved.branchId && String(resolved.branchId) !== String(branch._id)) {
          ranges = [];
        }
        if (!ranges.length) continue;
        const clamped = await clampToBranch(ranges, branch._id, day);
        if (!clamped.ranges.length) continue;
        const start = clamped.ranges.map((r) => r.start).sort()[0];
        const end = clamped.ranges.map((r) => r.end).sort().slice(-1)[0];
        plan.push({ doctorId: doctor.doctorId, doctorName: doctor.name, employeeId: link.zenotiEmployeeId, centerId, centerName: CENTERS[centerId].name, date: day, start, end });
      }
    }
  }
  return plan;
}

/** Publish the plan; returns a summary and, for dry runs, the plan itself. */
async function publishDoctorHours({ days = HORIZON_DAYS, doctorId = null, dryRun = false, trigger = 'schedule' } = {}) {
  if (running) return { skipped: 'already running' };
  running = true;
  const summary = { trigger, mode: mode(), planned: 0, written: 0, alreadyWorking: 0, failed: 0, dryRun: dryRun || !isLive() || !enabled(), errors: [] };
  try {
    const fullPlan = await planDoctorHours({ days, doctorId });
    const ambiguous = fullPlan.filter((p) => p.ambiguousCentre);
    const plan = fullPlan.filter((p) => !p.ambiguousCentre);
    summary.planned = plan.length;
    summary.heldBack = ambiguous.length;
    summary.heldBackDoctors = [...new Set(ambiguous.map((p) => p.doctorName))];
    if (!plan.length) return summary;
    // Existing Zenoti shifts, one read per centre for the whole window.
    const from = istDay(Date.now());
    const to = istDay(Date.now() + days * 864e5);
    const existing = new Map(); // `${employeeId}|${centerId}|${day}` -> shifts[]
    for (const centerId of [...new Set(plan.map((p) => p.centerId))]) {
      const rows = await zenoti.getCenterEmployeeSchedules(centerId, { from, to });
      for (const row of rows) for (const sft of row.shifts) {
        const key = `${row.employeeId}|${centerId}|${String(sft.date).slice(0, 10)}`;
        if (!existing.has(key)) existing.set(key, []);
        existing.get(key).push(sft);
      }
    }
    const writes = [];
    for (const entry of plan) {
      const shifts = existing.get(`${entry.employeeId}|${entry.centerId}|${entry.date}`) || [];
      if (shifts.some((sft) => Number(sft.status) === 0)) { summary.alreadyWorking += 1; continue; }
      if (shifts.some((sft) => Number(sft.status) > 0)) { summary.alreadyWorking += 1; continue; } // a leave code set by the clinic
      writes.push(entry);
    }
    if (summary.dryRun) { summary.wouldWrite = writes.length; summary.plan = writes; return summary; }
    for (const entry of writes) {
      const body = {
        center_id: entry.centerId,
        schedules: [{
          date: `${entry.date}T00:00:00`,
          shifts: [{ schedule_id: '', start_time: `${entry.date}T${entry.start}:00`, end_time: `${entry.date}T${entry.end}:00`, status: 0, room_no: '' }],
        }],
      };
      try {
        const res = await liveWrite('publishShift', () => zenoti.request(`/v1/employees/${entry.employeeId}/schedules`, { method: 'POST', body }), { bulk: true });
        if (res && res.success === false) throw new Error(res.error?.Message || res.error?.message || 'Zenoti rejected the shift');
        summary.written += 1;
      } catch (error) {
        summary.failed += 1;
        if (summary.errors.length < 5) summary.errors.push(`${entry.doctorName} ${entry.centerName} ${entry.date}: ${error.message}`);
        if (/breaker/i.test(error.message)) break;
      }
    }
    logger.info('Published dermatologist hours to Zenoti', summary);
    return summary;
  } finally {
    running = false;
  }
}

module.exports = { planDoctorHours, publishDoctorHours, enabled, isRunning: () => running, HORIZON_DAYS };
