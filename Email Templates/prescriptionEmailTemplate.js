/**
 * The signed prescription, as the guest receives it.
 *
 * `buildPrescriptionDocument` renders the standalone prescription — the same
 * layout the panel's Download button produces — used both inside the email
 * body and as the attached, downloadable file. Zennara is a clinic: this is a
 * record of what the dermatologist prescribed, sent right after they sign.
 */

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const fmtDate = (d) => {
  const date = d ? new Date(d) : new Date();
  return date.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
};

function buildPrescriptionDocument({ note, patient, booking, doctorName }) {
  const age = patient?.dateOfBirth
    ? Math.floor((Date.now() - new Date(patient.dateOfBirth).getTime()) / (365.25 * 86400000))
    : null;
  const items = (note.prescription || []).map((r) => {
    const bits = [r.dosage, r.frequency, r.duration, r.instructions].filter(Boolean).map(esc).join(' · ');
    return `<li>${esc(r.medicine)}${bits ? ` — ${bits}` : ''}${r.isScheduleH ? ' <b>(Sch H)</b>' : ''}</li>`;
  }).join('');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Prescription — ${esc(patient?.fullName)}</title>
<style>body{font-family:Georgia,serif;max-width:640px;margin:40px auto;color:#111;padding:0 16px}h1{font-size:20px;letter-spacing:2px}hr{border:0;border-top:1px solid #ccc}li{margin:8px 0}</style></head>
<body><h1>ZENNARA</h1><p>Skin · Aesthetics · Wellness${booking?.preferredLocation ? ` — ${esc(booking.preferredLocation)}` : ''}</p><hr>
<p><b>Patient:</b> ${esc(patient?.fullName)}${age ? ` · ${age} ${esc(patient?.gender || '')}` : ''}${patient?.patientId ? `<br><b>Patient ID:</b> ${esc(patient.patientId)}` : ''}<br><b>Date:</b> ${fmtDate(note.completedAt)}</p>
<p><b>Complaint:</b> ${esc(note.complaint) || '—'}</p><p><b>Examination:</b> ${esc(note.examination) || '—'}</p>
<p><b>Assessment:</b> ${esc(note.assessment) || '—'}</p><p><b>Plan:</b> ${esc(note.plan) || '—'}</p>
<h3>Rx</h3><ol>${items || '<li>—</li>'}</ol>
${note.followUpDate ? `<p><b>Review on:</b> ${fmtDate(note.followUpDate)}</p>` : ''}<hr>
<p><b>${esc(doctorName || note.doctorName || '')}</b></p>
<p style="font-size:11px;color:#777">This prescription was issued electronically by Zennara Clinics after your consultation. Keep it for your records; a pharmacy can dispense from the printed or displayed copy.</p>
</body></html>`;
}

function getPrescriptionEmailBody({ patientName, doctorName, location, docHtml }) {
  return `
    <!DOCTYPE html><html><head><meta charset="UTF-8"><style>
      body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f7fa;padding:32px 16px;color:#1F2937}
      .wrap{max-width:640px;margin:0 auto}
      .header{background:linear-gradient(135deg,#20594e 0%,#154239 100%);color:#fff;padding:28px 26px;border-radius:16px 16px 0 0}
      .header h1{font-size:22px;margin:0}.header p{margin:6px 0 0;font-size:13px;opacity:.85}
      .body{background:#fff;padding:26px;border-radius:0 0 16px 16px}
      .body p{font-size:14px;margin:0 0 14px}
      .doc{border:1px solid #dde5e0;border-radius:12px;overflow:hidden;margin-top:6px}
      .foot{font-size:11.5px;color:#9CA3AF;text-align:center;padding:16px}
    </style></head><body><div class="wrap">
      <div class="header"><h1>Your prescription</h1><p>Zennara — Skin · Aesthetics · Wellness</p></div>
      <div class="body">
        <p>Dear ${patientName || 'Guest'},</p>
        <p>Thank you for your consultation${doctorName ? ` with <b>${doctorName}</b>` : ''}${location ? ` at ${location}` : ''}.
        Your signed prescription is below, and attached as a file you can save, print, or show at a pharmacy.</p>
        <div class="doc">${docHtml}</div>
      </div>
      <div class="foot">This is an automated message from Zennara Clinics. If anything looks wrong, contact the clinic.</div>
    </div></body></html>`;
}

module.exports = { buildPrescriptionDocument, getPrescriptionEmailBody };
