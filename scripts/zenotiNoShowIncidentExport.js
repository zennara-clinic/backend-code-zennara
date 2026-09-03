/**
 * Incident 2026-09-03: list every Zenoti-booked appointment that our automatic
 * No Show job marked No Show (and that the lifecycle write-back then recorded
 * in Zenoti, or tried to). Read-only. Writes a CSV for the clinic to cross-check
 * against Zenoti's appointment change log (comment "No show recorded in Zennara")
 * and undo in Zenoti.
 *
 *   node scripts/zenotiNoShowIncidentExport.js [out.csv]
 */
require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const Booking = require('../models/Booking');

const out = process.argv[2] || 'zenoti-no-show-incident.csv';
const csv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const rows = await Booking.find({ source: 'zenoti', status: 'No Show' })
    .select('fullName mobileNumber preferredLocation preferredDate confirmedTime externalServiceName specialistName therapistName zenotiAppointmentId zenotiAppointmentGroupId zenotiInvoiceId zenotiSyncStatus zenotiSyncError zenotiSyncedAt zenotiLastInboundAt checkInTime zenotiSource updatedAt referenceNumber')
    .sort({ preferredDate: -1 })
    .lean();
  const evidence = (b) => {
    const s = b.zenotiSource?.status;
    if (b.zenotiSyncStatus === 'failed') return `Push attempted, Zenoti refused: ${b.zenotiSyncError || ''}`;
    if (s === 0 || s === 4) return 'Zenoti still showed Booked/Confirmed at last read → marked by Zennara';
    if (b.zenotiSyncedAt && b.zenotiLastInboundAt && new Date(b.zenotiSyncedAt) - new Date(b.zenotiLastInboundAt) > 2000) return 'Pushed to Zenoti by Zennara';
    if (s === -2) return 'Zenoti now shows No Show — verify against change log comment';
    return 'Unknown';
  };
  const header = ['Appointment date', 'Time', 'Centre', 'Guest', 'Mobile', 'Service', 'Provider', 'Zenoti appointment id', 'Zenoti appointment group id', 'Zenoti invoice id', 'Zenoti status at last read', 'Our sync status', 'Evidence', 'Our reference'];
  const lines = [header.map(csv).join(',')];
  const counts = {};
  for (const b of rows) {
    const ev = evidence(b);
    counts[ev.split(':')[0]] = (counts[ev.split(':')[0]] || 0) + 1;
    lines.push([
      b.preferredDate ? new Date(b.preferredDate).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) : '',
      b.confirmedTime || '', b.preferredLocation || '', b.fullName || '', b.mobileNumber || '',
      b.externalServiceName || '', b.specialistName || b.therapistName || '',
      b.zenotiAppointmentId || '', b.zenotiAppointmentGroupId || '', b.zenotiInvoiceId || '',
      b.zenotiSource?.status ?? '', b.zenotiSyncStatus || '', ev, b.referenceNumber || '',
    ].map(csv).join(','));
  }
  fs.writeFileSync(out, lines.join('\n'));
  console.log(`Wrote ${rows.length} rows to ${out}`);
  console.log(counts);
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
