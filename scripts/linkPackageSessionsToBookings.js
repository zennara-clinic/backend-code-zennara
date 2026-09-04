/**
 * Tie each used package session to the clinic visit that consumed it.
 *
 *   node scripts/linkPackageSessionsToBookings.js          (preview)
 *   node scripts/linkPackageSessionsToBookings.js --apply
 *
 * Zenoti's appointment rows carry no package reference, so this is inferred,
 * conservatively: for a package bought at the clinic, a session of service S
 * counted as used is linked to the customer's earliest unlinked booking of
 * that same service (same Zenoti service id, or the same normalised name)
 * dated inside the package's validity, that is not itself an app package
 * booking. Only the first `used` such visits are linked. Database only,
 * idempotent; never touches Zenoti.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { normalizeName } = require('../utils/nameMatch');
const APPLY = process.argv.includes('--apply');
(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const PackageAssignment = require('../models/PackageAssignment');
  const Booking = require('../models/Booking');
  const Consultation = require('../models/Consultation');
  const cons = await Consultation.find({}).select('_id id name zenotiServiceId').lean();
  const byId = new Map(cons.map((c) => [String(c._id), c]));
  const byCode = new Map(cons.map((c) => [c.id, c]));
  const out = { assignments: 0, sessionsUsed: 0, linked: 0, alreadyLinked: 0, noVisit: 0 };
  const cursor = PackageAssignment.find({ source: 'zenoti', 'sessions.0': { $exists: true } }).cursor();
  for await (const a of cursor) {
    const used = a.sessions.filter((s) => s.status === 'Completed');
    if (!used.length) continue;
    out.assignments += 1;
    out.sessionsUsed += used.length;
    out.alreadyLinked += used.filter((s) => s.bookingId).length;
    if (used.every((s) => s.bookingId)) continue;
    const from = a.validFrom || a.createdAt;
    const to = a.validUntil || new Date();
    const visits = await Booking.find({
      userId: a.userId, source: 'zenoti', status: 'Completed', isPackageIncluded: { $ne: true },
      eventAt: { $gte: new Date(new Date(from).getTime() - 24 * 3600 * 1000), $lte: new Date(new Date(to).getTime() + 24 * 3600 * 1000) },
    }).select('_id consultationId externalServiceName eventAt').sort({ eventAt: 1 }).lean();
    const taken = new Set((await PackageAssignment.find({ userId: a.userId, 'sessions.bookingId': { $ne: null } }).select('sessions.bookingId').lean())
      .flatMap((x) => x.sessions.map((s) => s.bookingId && String(s.bookingId))).filter(Boolean));
    let changed = false;
    for (const s of used) {
      if (s.bookingId) continue;
      const svc = byCode.get(s.serviceId);
      const want = normalizeName(s.serviceName);
      const visit = visits.find((v) => {
        if (taken.has(String(v._id))) return false;
        const vc = v.consultationId ? byId.get(String(v.consultationId)) : null;
        if (svc && vc && String(vc._id) === String(svc._id)) return true;
        return want && (normalizeName(v.externalServiceName) === want || (vc && normalizeName(vc.name) === want));
      });
      if (!visit) { out.noVisit += 1; continue; }
      taken.add(String(visit._id));
      s.bookingId = visit._id;
      s.completedAt = visit.eventAt || s.completedAt;
      out.linked += 1;
      changed = true;
    }
    if (APPLY && changed) { a.$locals.skipZenotiWrite = true; await a.save({ validateModifiedOnly: true }); }
  }
  console.log(APPLY ? 'APPLIED' : 'PREVIEW', JSON.stringify(out));
  await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
