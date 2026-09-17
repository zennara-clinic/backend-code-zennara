/**
 * What Zenoti's roster says about every linked dermatologist — read-only.
 *
 *   node scripts/reportZenotiRoster.js            # next 30 days
 *   node scripts/reportZenotiRoster.js 60         # next 60 days
 *
 * Per dermatologist and centre: the days Zenoti has them Working (with the
 * hours), on leave, or not scheduled. This is exactly what the app, the desk
 * and the panels book against, so if a day here is wrong the fix is in
 * Zenoti's Employee Schedule — nothing in this project writes a shift.
 *
 * Background: on 2026-09-03 a since-removed "publish dermatologist hours"
 * action wrote 10:00–19:00 Working shifts into Zenoti for every linked
 * dermatologist over a 21-day horizon. Any such shift still standing shows
 * up here as a Working day the clinic did not plan; clear it in Zenoti and
 * the app follows within seconds. Reads only; never writes.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Doctor = require('../models/Doctor');
const ZenotiPractitioner = require('../models/ZenotiPractitioner');
const { rosterForDoctor } = require('../services/zenotiAvailabilityService');
const { clinicDateKey, addClinicDays } = require('../utils/bookingTime');

const DAYS = Math.max(1, Math.min(90, Number(process.argv[2]) || 30));

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const from = clinicDateKey(new Date());
  const to = addClinicDays(from, DAYS - 1);
  const links = await ZenotiPractitioner.find({ active: true, onboardedDoctorId: { $ne: null } }).select('onboardedDoctorId').lean();
  const doctors = await Doctor.find({ doctorId: { $in: links.map((l) => l.onboardedDoctorId) }, isActive: { $ne: false } }).select('doctorId name').sort({ name: 1 }).lean();
  console.log(`Zenoti roster, ${from} → ${to} (${DAYS} days), ${doctors.length} linked dermatologists\n`);
  for (const doctor of doctors) {
    let roster;
    try { roster = await rosterForDoctor(doctor.doctorId, from, to); } catch (error) { console.log(`${doctor.name}: could not read (${error.message})\n`); continue; }
    console.log(`${doctor.name} [${doctor.doctorId}]`);
    for (const centre of roster.centres) {
      const working = []; const leave = [];
      for (const day of roster.days) {
        const entry = day.entries.find((e) => e.branchId === centre.branchId);
        if (!entry) continue;
        if (entry.state === 'working') working.push(`${day.date} ${entry.ranges.map((r) => `${r.start}-${r.end}`).join(',')}`);
        if (entry.state === 'leave') leave.push(`${day.date} (code ${entry.leaveCode})`);
      }
      console.log(`  ${centre.branchName}: ${working.length} working day${working.length === 1 ? '' : 's'}${leave.length ? `, ${leave.length} on leave` : ''}`);
      working.forEach((line) => console.log(`     working  ${line}`));
      leave.forEach((line) => console.log(`     leave    ${line}`));
    }
    if (!roster.centres.length) console.log('  (no Zenoti employee link at any clinic)');
    console.log('');
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; }).finally(() => mongoose.disconnect());
