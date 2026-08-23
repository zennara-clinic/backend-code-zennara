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
async function syncPractitioners({ trigger = 'schedule', repair = true } = {}) {
  if (!zenoti.isConfigured() || running) return null;
  running = true;
  try {
    const clinics = Object.entries(CENTERS).filter(([, center]) => center.isClinic);
    const results = await Promise.allSettled(clinics.map(([centerId]) => zenoti.getCenterEmployees(centerId)));
    const byId = new Map();
    results.forEach((result, index) => {
      if (result.status !== 'fulfilled') {
        logger.warn('Zenoti practitioner centre refresh failed', { center: clinics[index][1].name, error: result.reason?.message });
        return;
      }
      const [centerId, center] = clinics[index];
      result.value.filter((employee) => /^doctor$/i.test(String(employee.jobName || '').trim())).forEach((employee) => {
        const row = byId.get(employee.id) || { ...employee, centerIds: [], centerNames: [] };
        if (!row.centerIds.includes(centerId)) row.centerIds.push(centerId);
        if (!row.centerNames.includes(center.name)) row.centerNames.push(center.name);
        byId.set(employee.id, row);
      });
    });

    if (!byId.size && results.some((result) => result.status === 'rejected')) return { trigger, seen: 0, repaired: 0 };

    const doctors = await Doctor.find({}).select('doctorId name tier').lean();
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

module.exports = { syncPractitioners, repairBookingAttribution, isRunning, looksLikeDoctor };
