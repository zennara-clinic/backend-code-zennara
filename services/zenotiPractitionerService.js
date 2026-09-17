const Booking = require('../models/Booking');
const Doctor = require('../models/Doctor');
const ZenotiPractitioner = require('../models/ZenotiPractitioner');
const zenoti = require('./zenotiService');
const { CENTERS } = require('../config/zenoti');
const { buildDoctorMatcher, canonicalName, splitCombinedName, tierTitle } = require('../utils/dermatologistMatch');
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

/**
 * Keep the Doctor row in step with the Zenoti practitioner link.
 *
 * `availableCentres` is what the APP reads to decide which dermatologists to
 * offer at a centre, and it was typed by hand in the panel — so it drifted from
 * Zenoti for seven of nine active dermatologists (2026-09-08). Janaki was
 * offered at two centres Zenoti has never had her at; Rickson, Spoorthy,
 * Madhurya, Meghana, Monica and Bandhavi were each offered at fewer centres
 * than Zenoti has them at, hiding real bookable time the moment they were
 * rostered there.
 *
 * Zenoti decides where a practitioner works, so it decides this too. Synced on
 * every practitioner pass (every 5 minutes), which makes a change in Zenoti
 * show up here on its own. Zenoti's centre names are matched to our Branch
 * names rather than copied, so a rename on either side cannot invent a centre.
 *
 * A doctor with NO Zenoti centres keeps whatever the panel set — an unlinked,
 * local-only dermatologist is still managed here.
 */
async function stampDoctorLink(row) {
  if (!row?.onboardedDoctorId) return;
  const Doctor = require('../models/Doctor');
  const Branch = require('../models/Branch');
  const set = {
    zenotiEmployeeId: row.zenotiEmployeeId,
    zenotiCenterNames: row.centerNames || [],
  };
  const zenotiNames = (row.centerNames || []).map((n) => String(n).trim().toLowerCase());
  if (zenotiNames.length) {
    const branches = await Branch.find({ isActive: true, centreType: 'clinic' }).select('name').lean();
    const matched = branches
      .filter((b) => zenotiNames.includes(String(b.name).trim().toLowerCase()))
      .map((b) => b.name);
    if (matched.length) set.availableCentres = matched;
  }
  await Doctor.updateOne(
    { doctorId: String(row.onboardedDoctorId).toLowerCase() },
    { $set: set },
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
      // A combined Zenoti column ("Dr A - Dr B") is useful for appointment
      // attribution, but it is not one person's bookable employee identity.
      // Linking it to the first doctor creates two active employee ids for
      // that doctor and makes schedule/write-back selection arbitrary.
      const onboarded = splitCombinedName(employee.name).length === 1
        ? matchDoctor(employee.name)
        : null;
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

/*
 * Zenoti is the roster of record — full stop.
 *
 * Shifts, leave and block-outs are read live from Zenoti by
 * services/zenotiAvailabilityService for every decision (app slots, desk
 * confirm, reschedule, the day book). Nothing here copies the roster into
 * the local DermatologistSchedule any more, and nothing anywhere writes a
 * shift back to Zenoti: the earlier mirror kept a day OPEN whenever Zenoti
 * had nothing scheduled ("roster not published yet" and "not working" look
 * the same there), and the earlier publisher wrote 10:00–19:00 Working
 * shifts into Zenoti for every dermatologist on every day of a three-week
 * horizon — which is how a doctor who visits twice a month came to be
 * rostered daily. Both are gone; Zenoti says who works when, and we follow.
 */
function clip(ranges, shifts) {
  const out = [];
  for (const r of ranges) for (const sft of shifts) {
    const start = r.start > sft.start ? r.start : sft.start;
    const end = r.end < sft.end ? r.end : sft.end;
    if (start < end) out.push({ start, end });
  }
  return out;
}

/** Onboard every active Zenoti doctor that has no app dermatologist yet. */
async function autoOnboardAll() {
  for (const linked of await ZenotiPractitioner.find({ active: true, onboardedDoctorId: { $ne: null } }).lean()) await stampDoctorLink(linked);
  const rows = await ZenotiPractitioner.find({ active: true, $or: [{ jobName: /doctor/i, onboardedDoctorId: null }, { jobName: /therapist/i, onboardedAdminId: null }] });
  let n = 0;
  for (const row of rows) { if (await autoOnboard(row).catch(() => null)) n += 1; }
  return n;
}

module.exports = { syncPractitioners, repairBookingAttribution, clipRangesToShifts: clip, isRunning, looksLikeDoctor, autoOnboard, autoOnboardAll };
