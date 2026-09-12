/**
 * The note that carries the signed prescription to the guest's inbox.
 *
 * Since 2026-09-12 the prescription itself travels as a PDF attachment
 * (utils/prescriptionPdf), so the email body is a short covering note and no
 * longer the whole document: inboxes stripped the sheet's CSS and fonts, and
 * a guest could neither print nor forward what they saw. Zennara is a clinic
 * — this is a record of what the dermatologist prescribed, sent the moment
 * they sign, and the PDF is that record.
 *
 * Set in Poppins, like the prescription. Gmail and Outlook ignore web-font
 * links, so the stack falls back to the system sans; nothing here depends on
 * the font loading.
 */

const { fmtDate, esc } = require('../utils/prescriptionTemplates');

const FOREST = '#2c3e2f';
const CREAM = '#f7f5ef';
const INK = '#1f2a22';
const MUTED = '#6b756e';
const SANS = "'Poppins', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

function getPrescriptionEmailBody({ patientName, doctorName, location, signedAt }) {
  const who = doctorName ? `Dr ${esc(String(doctorName).replace(/^dr\.?\s*/i, ''))}` : 'your dermatologist';
  const where = location ? ` at Zennara ${esc(location)}` : ' at Zennara';
  const when = signedAt ? fmtDate(signedAt) : '';
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  body{margin:0;background:${CREAM};font-family:${SANS};color:${INK}}
  .wrap{max-width:560px;margin:0 auto;padding:32px 16px}
  .card{background:#fff;border-radius:6px;padding:28px 28px 24px;border-top:4px solid ${FOREST}}
  h1{font:600 18px/1.3 ${SANS};color:${FOREST};margin:0 0 14px}
  p{font:400 14px/1.6 ${SANS};margin:0 0 12px}
  .file{display:inline-block;margin:6px 0 14px;padding:8px 12px;border:1px solid ${FOREST};border-radius:4px;font:500 12.5px/1.3 ${SANS};color:${FOREST}}
  .dim{color:${MUTED};font-size:12px}
  .foot{font:400 11.5px/1.5 ${SANS};color:${MUTED};text-align:center;padding:16px 8px 0}
</style></head><body><div class="wrap">
  <div class="card">
    <h1>Your prescription</h1>
    <p>Dear ${esc(patientName || 'Guest')},</p>
    <p>Your prescription from ${who}${where}${when ? `, signed on ${esc(when)},` : ''} is attached to this email as a PDF.</p>
    <span class="file">&#128206; prescription.pdf</span>
    <p>Keep it for your records — a pharmacy can dispense from the printed or displayed copy. It is also in the Zennara app under <b>My Prescriptions</b>.</p>
    <p class="dim">If anything on it looks wrong, please contact the clinic rather than replying to this email.</p>
  </div>
  <div class="foot">Zennara Clinics — Skin · Aesthetics · Wellness<br>This is an automated message.</div>
</div></body></html>`;
}

module.exports = { getPrescriptionEmailBody };
