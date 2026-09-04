const Booking = require('../models/Booking');
const Doctor = require('../models/Doctor');
const ZenotiPractitioner = require('../models/ZenotiPractitioner');
const zenoti = require('./zenotiService');
const { CENTERS } = require('../config/zenoti');
const { buildDoctorMatcher, canonicalName, tierTitle } = require('../utils/dermatologistMatch');
const logger = require('../utils/logger');

let running = false;

const looksLikeDoctor = (name) => /^\s*dr\.?\s*/i.test(String(name || ''));
const updateManyIfChanged = (filter, set) => ({
  updateMany: {
    filter: {
      ...filter,
      $or: Object.entries(set).map(([field, value]) => (value === null
        ? { [field]: { $exists: true, $ne: null } }
        : { [field]: { $ne: value } })),
    },
    update: { $set: set },
  },
});

/**
 * Mirror Zenoti's Doctor employees into a reporting-only collection. This does
 * not create or update a Doctor profile and therefore cannot publish anyone to
 * the customer app.
 */

/**
 * Create the app dermatologist for a Zenoti doctor who has none.
 *
 * A doctor added in Zenoti used to sit in "In Zenoti, not yet in the app"
 * until somebody pressed Onboard. Now they arrive automatically — HIDDEN
 * (isActive:false), on the standard tier, at the centres Zenoti rosters them
 * at — so the panel shows them straight away and a person only has to add a
 * photo, bio and fee and publish. Disable with ZENOTI_AUTO_ONBOARD_DOCTORS=false.
 */

/**
 * A therapist rostered in Zenoti becomes a therapist account here — HIDDEN
 * (isActive:false) — so the Therapists page lists them and bookings attribute
 * to them. Zenoti's user name is used as the login email when it is one;
 * otherwise a placeholder that cannot sign in until reception sets a real
 * email and password. Never duplicates a therapist who already exists by name.
 */

/** Keep Doctor.zenotiEmployeeId / zenotiCenterNames in step with the practitioner link. */
async function stampDoctorLink(row) {
  if (!row?.onboardedDoctorId) return;
  const Doctor = require('../models/Doctor');
  await Doctor.updateOne(
    { doctorId: String(row.onboardedDoctorId).toLowerCase() },
    { $set: { zenotiEmployeeId: row.zenotiEmployeeId, zenotiCenterNames: row.centerNames || [] } },
  ).catch(() => {});
}

async function autoOnboardTherapist(row) {
  if (row.onboardedAdminId) return row.onboardedAdminId;
  const Admin = require('../models/Admin');
  const Branch = require('../models/Branch');
  const name = String(row.name || '').trim();
  if (!name) return null;
  const rx = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  let admin = await Admin.findOne({ role: 'therapist', name: rx });
  if (!admin) {
    const branches = await Branch.find({ name: { $in: row.centerNames || [] } }).select('_id').lean();
    const email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(row.zenotiUserName || ''))
      ? String(row.zenotiUserName).toLowerCase()
      : `zenoti.${String(row.zenotiEmployeeId).slice(0, 8)}@zennara.local`;
    if (await Admin.exists({ email })) return null; // someone else owns that address — leave it to a person
    admin = await Admin.create({
      name, email, role: 'therapist', isActive: false, isVerified: false,
      branchId: branches[0]?._id || null, branchIds: branches.map((b) => b._id),
    });
    logger.info('Zenoti therapist auto-onboarded (hidden) as therapist account', { employeeId: row.zenotiEmployeeId, adminId: admin._id });
  }
  row.onboardedAdminId = admin._id;
  await row.save();
  return admin._id;
}

async function autoOnboard(row) {
  if (String(process.env.ZENOTI_AUTO_ONBOARD_DOCTORS || 'true').toLowerCase() === 'false') return null;
  if (/therapist/i.test(row.jobName || '')) return autoOnboardTherapist(row);
  if (row.onboardedDoctorId) return row.onboardedDoctorId;
  const doctorController = require('../controllers/doctorController');
  const Doctor = require('../models/Doctor');
  const name = String(row.name || '').replace(/^\s*dr\.?\s*/i, '').replace(/\s*\.\s*$/, '').trim();
  if (!name) return null;
  // Same person already in the app under this name (e.g. added by hand): link, don't duplicate.
  const existing = await Doctor.findOne({ name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).select('doctorId').lean();
  if (existing?.doctorId) {
    // Same name, but already the app identity of a different Zenoti employee →
    // two people share a name. Do not merge; leave it for a person.
    const claimed = await ZenotiPractitioner.exists({ onboardedDoctorId: existing.doctorId, zenotiEmployeeId: { $ne: row.zenotiEmployeeId } });
    if (claimed) { logger.warn('Auto-onboard skipped: name already linked to another Zenoti doctor', { name, employeeId: row.zenotiEmployeeId }); return null; }
    row.onboardedDoctorId = existing.doctorId; await row.save(); await stampDoctorLink(row); return existing.doctorId;
  }

  let created = null;
  const fakeRes = { status(code) { this.code = code; return this; }, json(body) { created = { code: this.code || 200, body }; } };
  await doctorController.createDoctor({
    admin: { _id: null, email: 'zenoti-sync', role: 'super_admin', isSuperAdmin: true, permissions: new Set() },
    body: {
      name,
      tier: (Doctor.schema.path('tier').enumValues || []).find((t) => !/senior/i.test(t)) || 'dermatologist',
      availableCentres: row.centerNames || [],
      isActive: false,
    },
  }, fakeRes);
  const doctorId = created && created.code < 400 ? created.body?.data?.doctorId : null;
  if (!doctorId) { logger.warn('Auto-onboard failed', { employeeId: row.zenotiEmployeeId, name, error: created?.body?.message }); return null; }
  row.onboardedDoctorId = doctorId;
  await row.save();
  await stampDoctorLink(row);
  logger.info('Zenoti doctor auto-onboarded (hidden) as app dermatologist', { employeeId: row.zenotiEmployeeId, doctorId });
  return doctorId;
}

async function syncPractitioners({ trigger = 'schedule', repair = true } = {}) {
  if (!zenoti.isConfigured() || running) return null;
  running = true;
  try {
    const clinics = Object.entries(CENTERS).filter(([, center]) => center.isClinic);
    // Doctors come from the employee list; therapists from Zenoti's separate
    // therapist list (they are not on the employee job list — verified live).
    const results = await Promise.allSettled(clinics.map(async ([centerId]) => {
      const [employees, therapists] = await Promise.all([
        zenoti.getCenterEmployees(centerId),
        zenoti.getCenterTherapists(centerId).catch(() => []),
      ]);
      const seen = new Set(employees.map((e) => e.id));
      return [
        ...employees,
        ...therapists.filter((t) => t.id && !seen.has(t.id)).map((t) => ({ ...t, jobName: /doctor/i.test(t.jobName || '') ? 'Doctor' : 'Therapist' })),
      ];
    }));
    const byId = new Map();
    results.forEach((result, index) => {
      if (result.status !== 'fulfilled') {
        logger.warn('Zenoti practitioner centre refresh failed', { center: clinics[index][1].name, error: result.reason?.message });
        return;
      }
      const [centerId, center] = clinics[index];
      result.value.filter((employee) => /^(doctor|therapist)$/i.test(String(employee.jobName || '').trim())).forEach((employee) => {
        const row = byId.get(employee.id) || { ...employee, centerIds: [], centerNames: [] };
        if (!row.centerIds.includes(centerId)) row.centerIds.push(centerId);
        if (!row.centerNames.includes(center.name)) row.centerNames.push(center.name);
        byId.set(employee.id, row);
      });
    });

    if (!byId.size && results.some((result) => result.status === 'rejected')) return { trigger, seen: 0, repaired: 0 };

    // Only a live app dermatologist may claim a Zenoti identity; a retired
    // profile must not keep absorbing the clinic's visits and revenue.
    const doctors = await Doctor.find({ isActive: { $ne: false } }).select('doctorId name tier').lean();
    const matchDoctor = buildDoctorMatcher(doctors);
    const now = new Date();
    const ops = [...byId.values()].map((employee) => {
      const onboarded = matchDoctor(employee.name);
      return {
        updateOne: {
          filter: { zenotiEmployeeId: employee.id },
          update: {
            $set: {
              name: employee.name,
              normalizedName: canonicalName(employee.name),
              jobName: employee.jobName || 'Doctor',
              zenotiUserName: employee.userName || null,
              centerIds: employee.centerIds,
              centerNames: employee.centerNames,
              onboardedDoctorId: onboarded?.doctorId || null,
              active: true,
              lastSeenAt: now,
              syncedAt: now,
            },
          },
          upsert: true,
        },
      };
    });
    if (ops.length) await ZenotiPractitioner.bulkWrite(ops, { ordered: false });

    // Only deactivate missing rows when every clinic answered successfully.
    if (results.every((result) => result.status === 'fulfilled')) {
      await ZenotiPractitioner.updateMany(
        { zenotiEmployeeId: { $nin: [...byId.keys()] }, active: true },
        { $set: { active: false, syncedAt: now } },
      );
    }

    const repaired = repair ? await repairBookingAttribution({ doctors }) : 0;
    logger.info('Zenoti practitioner roster refreshed', { trigger, seen: byId.size, repaired });
    return { trigger, seen: byId.size, repaired };
  } finally {
    running = false;
  }
}

/** Repair historical false matches created when arbitrary therapists were
 * previously compared directly with the app Doctor roster. */
async function repairBookingAttribution({ doctors = null } = {}) {
  const [localDoctors, practitioners, names] = await Promise.all([
    doctors || Doctor.find({}).select('doctorId name tier').lean(),
    ZenotiPractitioner.find({}).lean(),
    Booking.distinct('therapistName', { source: 'zenoti', therapistName: /\S/ }),
  ]);
  const localById = new Map(localDoctors.map((doctor) => [String(doctor.doctorId), doctor]));
  const localByName = new Map(localDoctors.map((doctor) => [canonicalName(doctor.name), doctor]));
  const matchLocal = buildDoctorMatcher(localDoctors);
  const externalByName = new Map(practitioners.map((row) => [row.normalizedName || canonicalName(row.name), row]));
  const writes = [];

  for (const therapistName of names) {
    const external = externalByName.get(canonicalName(therapistName));
    if (external) {
      const local = external.onboardedDoctorId ? localById.get(String(external.onboardedDoctorId)) : null;
      writes.push(updateManyIfChanged({ source: 'zenoti', therapistName }, {
        zenotiTherapistId: external.zenotiEmployeeId,
        zenotiTherapistName: external.name,
        specialistId: local?.doctorId || null,
        specialistName: local?.name || external.name,
        specialistTier: local ? tierTitle(local) : 'Zenoti practitioner',
      }));
    } else if (looksLikeDoctor(therapistName)) {
      const local = matchLocal(therapistName);
      writes.push(updateManyIfChanged({ source: 'zenoti', therapistName }, {
        zenotiTherapistName: therapistName,
        specialistId: local?.doctorId || null,
        specialistName: local?.name || therapistName.replace(/^dr\.?\s*/i, 'Dr '),
        specialistTier: local ? tierTitle(local) : 'Zenoti practitioner',
      }));
    } else {
      writes.push(updateManyIfChanged({ source: 'zenoti', therapistName }, {
        zenotiTherapistName: therapistName, specialistId: null, specialistName: null, specialistTier: null,
      }));
    }
  }
  let modified = 0;
  if (writes.length) {
    const result = await Booking.bulkWrite(writes, { ordered: false });
    modified += result.modifiedCount || 0;
  }

  // Some legacy mirrors had specialistName but no therapistName. Re-evaluate
  // those after the first repair so arbitrary treatment staff cannot remain on
  // dermatologist dashboards merely because their raw provider field was lost.
  const specialistNames = await Booking.distinct('specialistName', { source: 'zenoti', specialistName: /\S/ });
  const specialistWrites = [];
  for (const specialistName of specialistNames) {
    const external = externalByName.get(canonicalName(specialistName));
    const local = external?.onboardedDoctorId
      ? localById.get(String(external.onboardedDoctorId))
      : localByName.get(canonicalName(specialistName)) || (looksLikeDoctor(specialistName) ? matchLocal(specialistName) : null);
    let update;
    if (local) {
      update = {
        specialistId: local.doctorId,
        specialistName: local.name,
        specialistTier: tierTitle(local),
        ...(external ? { zenotiTherapistId: external.zenotiEmployeeId, zenotiTherapistName: external.name } : {}),
      };
    } else if (external || looksLikeDoctor(specialistName)) {
      update = {
        specialistId: null,
        specialistName: external?.name || specialistName,
        specialistTier: 'Zenoti practitioner',
        ...(external ? { zenotiTherapistId: external.zenotiEmployeeId, zenotiTherapistName: external.name } : {}),
      };
    } else {
      update = { specialistId: null, specialistName: null, specialistTier: null };
    }
    specialistWrites.push(updateManyIfChanged({ source: 'zenoti', specialistName }, update));
  }
  if (specialistWrites.length) {
    const result = await Booking.bulkWrite(specialistWrites, { ordered: false });
    modified += result.modifiedCount || 0;
  }
  return modified;
}

function isRunning() { return running; }

/* ---------------------------------------------------------------------------
 * Zenoti roster → app availability.
 *
 * The app's slot engine reads DermatologistSchedule (hours set in the panel).
 * Zenoti's employee schedule is the clinic's actual roster. This pass lets the
 * roster NARROW app availability, never extend it and never close a day:
 *   - a day where Zenoti has the doctor Working at a centre keeps the panel
 *     hours, clipped to the Zenoti shift (so the app cannot sell 18:30 when
 *     Zenoti rosters them until 18:00);
 *   - a day with no Working shift is left to the panel hours. Zenoti uses the
 *     same "NotScheduled" for "off that day" and "roster not published yet",
 *     and the clinic publishes day by day — closing on silence blanked three
 *     doctors for two weeks on 2026-09-03. Days off are set in the panel.
 * Overrides it writes are tagged source:'zenoti' and rewritten each pass;
 * manual overrides (leave, one-off hours) always win and are never touched.
 * ------------------------------------------------------------------------- */
const SHIFT_WINDOW_DAYS = 14;
let shiftSyncRunning = false;

function clip(ranges, shifts) {
  const out = [];
  for (const r of ranges) for (const sft of shifts) {
    const start = r.start > sft.start ? r.start : sft.start;
    const end = r.end < sft.end ? r.end : sft.end;
    if (start < end) out.push({ start, end });
  }
  return out;
}
const hhmm = (iso) => (String(iso || '').match(/T(\d{2}:\d{2})/) || [])[1] || null;
const dayKey = (iso) => String(iso || '').slice(0, 10);

async function syncDoctorShiftsFromZenoti({ trigger = 'schedule' } = {}) {
  if (!zenoti.isConfigured() || shiftSyncRunning) return null;
  shiftSyncRunning = true;
  const summary = { trigger, doctors: 0, applied: 0, clippedDays: 0, skippedUnpublished: 0 };
  try {
    const DermatologistSchedule = require('../models/DermatologistSchedule');
    const Branch = require('../models/Branch');
    const linked = await ZenotiPractitioner.find({ active: true, onboardedDoctorId: { $ne: null } }).lean();
    if (!linked.length) return summary;
    const clinics = Object.entries(CENTERS).filter(([, c]) => c.isClinic);
    const branches = await Branch.find({ isActive: true }).select('_id name').lean();
    const branchByName = new Map(branches.map((b) => [b.name, b]));
    const istDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const from = istDay(Date.now());
    const to = istDay(Date.now() + SHIFT_WINDOW_DAYS * 864e5);
    // One schedules call per clinic (not per doctor) — the rate budget is shared with production.
    const perCenter = new Map();
    for (const [centerId, c] of clinics) {
      const rows = await zenoti.getCenterEmployeeSchedules(centerId, { from, to }).catch(() => null);
      if (rows) perCenter.set(centerId, { center: c, rows: new Map(rows.map((r) => [r.employeeId, r])) });
    }
    for (const practitioner of linked) {
      summary.doctors += 1;
      const schedule = await DermatologistSchedule.findOne({ doctorId: practitioner.onboardedDoctorId });
      if (!schedule) continue;
      // Working shifts for this doctor, per centre, per day.
      const working = new Map(); // `${day}|${branchId}` -> [{start,end}]
      let anyWorking = false;
      for (const [, { center, rows }] of perCenter) {
        const branch = branchByName.get(center.branchName);
        const row = rows.get(practitioner.zenotiEmployeeId);
        if (!branch || !row) continue;
        for (const sft of row.shifts) {
          if (Number(sft.status) !== 0) continue;
          const start = hhmm(sft.start), end = hhmm(sft.end);
          if (!start || !end) continue;
          const key = `${dayKey(sft.date)}|${branch._id}`;
          if (!working.has(key)) working.set(key, []);
          working.get(key).push({ start, end });
          anyWorking = true;
        }
      }
      // Centres where Zenoti has actually rostered this doctor in the window.
      // A centre with no Working shift at all is treated as "not published
      // there" and left to the panel hours — partial publishing (one clinic
      // done, another not) must not close a doctor's days elsewhere.
      const publishedBranches = new Set([...working.keys()].map((k) => k.split('|')[1]));
      const manual = (schedule.overrides || []).filter((o) => o.source !== 'zenoti');
      if (!anyWorking) {
        // Roster not published for this doctor: drop stale zenoti overrides, keep panel hours.
        summary.skippedUnpublished += 1;
        if (manual.length !== (schedule.overrides || []).length) { schedule.overrides = manual; await schedule.save(); }
        continue;
      }
      const manualDays = new Set(manual.map((o) => `${o.date}|${o.branchId || ''}`));
      const generated = [];
      for (let i = 0; i <= SHIFT_WINDOW_DAYS; i += 1) {
        const day = istDay(Date.now() + i * 864e5);
        const weekday = new Date(`${day}T12:00:00Z`).getUTCDay(); // weekday of that calendar date, 0 = Sunday
        const weeklyRows = (schedule.weekly || []).filter((w) => w.day === weekday);
        for (const branch of branches) {
          if (!publishedBranches.has(String(branch._id))) continue; // roster not published at this centre
          if (manualDays.has(`${day}|${branch._id}`) || manualDays.has(`${day}|`)) continue; // manual wins
          const shifts = working.get(`${day}|${branch._id}`) || [];
          const rowsForBranch = weeklyRows.filter((w) => !w.branchId || String(w.branchId) === String(branch._id));
          const panelRanges = rowsForBranch.flatMap((w) => (w.ranges || []).map((r) => ({ start: r.start, end: r.end })));
          if (!panelRanges.length) continue; // the panel never opened this day/centre; nothing to restrict
          if (!shifts.length) continue; // Zenoti is silent about this day: panel hours stand
          const clipped = clip(panelRanges, shifts);
          const same = clipped.length === panelRanges.length && clipped.every((r, idx) => r.start === panelRanges[idx].start && r.end === panelRanges[idx].end);
          if (!same) {
            generated.push({ date: day, branchId: branch._id, unavailable: !clipped.length, ranges: clipped, note: 'Clipped to the Zenoti shift', source: 'zenoti' });
            summary.clippedDays += 1;
          }
        }
      }
      schedule.overrides = [...manual, ...generated];
      await schedule.save();
      summary.applied += 1;
    }
    logger.info('Zenoti roster applied to app availability', summary);
    return summary;
  } catch (error) {
    logger.warn('Zenoti roster → availability sync failed', { error: error.message });
    return summary;
  } finally {
    shiftSyncRunning = false;
  }
}

/** Onboard every active Zenoti doctor that has no app dermatologist yet. */
async function autoOnboardAll() {
  for (const linked of await ZenotiPractitioner.find({ active: true, onboardedDoctorId: { $ne: null } }).lean()) await stampDoctorLink(linked);
  const rows = await ZenotiPractitioner.find({ active: true, $or: [{ jobName: /doctor/i, onboardedDoctorId: null }, { jobName: /therapist/i, onboardedAdminId: null }] });
  let n = 0;
  for (const row of rows) { if (await autoOnboard(row).catch(() => null)) n += 1; }
  return n;
}

module.exports = { syncPractitioners, repairBookingAttribution, syncDoctorShiftsFromZenoti, clipRangesToShifts: clip, isRunning, looksLikeDoctor, autoOnboard, autoOnboardAll };
