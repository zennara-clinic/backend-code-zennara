/**
 * The signed prescription, as the guest receives it.
 *
 * `buildPrescriptionDocument` renders the standalone prescription — the same
 * design the panel prints and the app shows — used both inside the email
 * body and as the attached, downloadable file. Zennara is a clinic: this is a
 * record of what the dermatologist prescribed, sent right after they sign.
 */

const { buildView, renderPrescriptionHtml } = require('../utils/prescriptionTemplates');

/*
 * Since 2026-09 the document is drawn by utils/prescriptionTemplates in the
 * design the dermatologist chose on the note, so the attachment, the panel's
 * print and the guest's in-app copy are the same page. The email only ever
 * carries a signed prescription, so the preview ribbon is never stamped here.
 */
function buildPrescriptionDocument({ note, patient, booking, doctorName }) {
  const view = buildView({ note, patient, booking, doctorName });
  return renderPrescriptionHtml(view, { template: note?.prescriptionTemplate, draft: false });
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
