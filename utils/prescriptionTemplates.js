/**
 * The prescription as a printed document — one view, three designs.
 *
 * Until 2026-09 a prescription was drawn three different ways: the
 * dermatologist panel's on-screen sheet, the email attachment (a plain serif
 * page) and the app's card list. They disagreed on fields, order and look, so
 * the guest, the pharmacy and the clinic each held a different "copy" of the
 * same document. The clinic asked for a small set of Zennara-branded designs
 * that the dermatologist picks while writing, with the SAME design reaching
 * the guest in the app and in the email.
 *
 * So:
 *   · `buildView()` turns a note + guest + booking into one plain object;
 *     every renderer reads that and nothing else, which is what keeps the
 *     three surfaces in agreement.
 *   · `renderPrescriptionHtml()` produces a complete standalone HTML page for
 *     the chosen template. It is served to the panel (preview and print), to
 *     the app (the guest's own copy) and dropped into the email attachment.
 *
 * The template is a layout choice stored on the note. It is NOT clinical
 * content: switching it never revokes a signature (utils/noteSignature) and
 * never triggers the Zenoti note mirror (the model's `_clinicalChanged`).
 *
 * Brand: forest green on white, extended only with green-family neutrals.
 * Manrope for the interface. The clinic's logo — the real one, not a typed
 * wordmark — heads every layout: inlined as a data URI for the panel preview,
 * download and print (so they render with no network), and fetched from the
 * API's /assets route in the email, where inboxes need an image they can load
 * by URL.
 */

const { guestCodeOf } = require('./guestCode');
const { ageFromDateOfBirth } = require('./dateOfBirth');

const TEMPLATES = ['classic', 'modern', 'minimal'];

const META = {
  classic: { key: 'classic', name: 'Classic', tagline: 'Cream paper, centred wordmark, a traditional Rx sheet' },
  modern: { key: 'modern', name: 'Modern', tagline: 'Green header band, clean sections, clear tables' },
  minimal: { key: 'minimal', name: 'Minimal', tagline: 'Ink on white, compact — for a plain office printer' },
};

/** Picker options, in display order. */
const templateMeta = () => TEMPLATES.map((key) => ({ ...META[key] }));

const BRAND = {
  forest: '#2c3e2f',
  cream: '#f7f5ef',
  sage: '#e6ece7',
  ink: '#1f2a22',
  muted: '#6b756e',
  white: '#ffffff',
};

/* --- Formatting -------------------------------------------------------- */

const esc = (v) => String(v ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Clinic-time date parts, so a late-night signature carries the Indian date. */
const clinicParts = (d) => {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(d);
  return Object.fromEntries(parts.filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
};

/** "3 Sep 2026" — the date policy: always with the year, in Asia/Kolkata. */
function fmtDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const p = clinicParts(d);
  return `${Number(p.day)} ${MONTHS[Number(p.month) - 1]} ${p.year}`;
}

/** "3 Sep 2026, 4:12 pm" — for the signature stamp. */
function fmtDateTime(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const p = clinicParts(d);
  return `${Number(p.day)} ${MONTHS[Number(p.month) - 1]} ${p.year}, ${p.hour}:${p.minute} ${String(p.dayPeriod || '').toLowerCase()}`.trim();
}

/**
 * Age from whatever the guest record holds. App sign-up stores "DD/MM/YYYY";
 * the walk-in tablet and Zenoti imports store a cast Date string, so both
 * shapes must resolve or half the clinic's prescriptions would print no age.
 */
function ageOf(dateOfBirth, now = new Date()) {
  if (!dateOfBirth) return null;
  const parsed = ageFromDateOfBirth(String(dateOfBirth), now);
  if (parsed !== null) return parsed;
  const d = new Date(dateOfBirth);
  if (Number.isNaN(d.getTime())) return null;
  const age = Math.floor((now.getTime() - d.getTime()) / (365.25 * 86400000));
  return age >= 0 && age < 130 ? age : null;
}

/** "14 days", "2 weeks", "1 month", "10 days x 2" → days; null when unparseable. */
function daysFromDuration(text) {
  const m = String(text || '').match(/(\d+(?:\.\d+)?)\s*(day|week|month|wk|mo)/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit.startsWith('w')) return Math.round(n * 7);
  if (unit.startsWith('m')) return Math.round(n * 30);
  return Math.round(n);
}

/** When a refill of this line falls due, counted from the day it was prescribed. */
function refillDueAt(note, item) {
  const days = Number(item.refillAfterDays) > 0 ? Number(item.refillAfterDays) : daysFromDuration(item.duration);
  if (!days) return null;
  const from = note.completedAt || note.createdAt;
  return from ? new Date(new Date(from).getTime() + days * 86400000) : null;
}

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const isObj = (v) => v && typeof v === 'object';

/* --- The view ---------------------------------------------------------- */

/**
 * One plain object every renderer reads.
 *
 * `patient` and `booking` may be passed explicitly (the email path) or left
 * to the populated `note.userId` / `note.bookingId` (the HTML endpoints).
 * Contact details are deliberately absent: a prescription carries the
 * guest's name and code, never their phone or email.
 */
function buildView({ note = {}, patient = null, booking = null, doctorName = null } = {}) {
  const n = note || {};
  const guest = patient || (isObj(n.userId) && n.userId.fullName !== undefined ? n.userId : null) || {};
  const bk = booking || (isObj(n.bookingId) && !(typeof n.bookingId.toHexString === 'function') ? n.bookingId : null) || {};
  const service = isObj(bk.consultationId) ? bk.consultationId : null;

  const items = (Array.isArray(n.prescription) ? n.prescription : []).map((item) => ({
    medicine: str(item.medicine),
    strength: str(item.strength) || null,
    formulation: str(item.formulation) || null,
    dosage: str(item.dosage) || null,
    frequency: str(item.frequency) || null,
    duration: str(item.duration) || null,
    timing: str(item.timing) || null,
    instructions: str(item.instructions) || null,
    isScheduleH: Boolean(item.isScheduleH),
    refillDueAt: refillDueAt(n, item),
  }));

  const allergies = guest.hasDrugAllergy || str(guest.drugAllergies) ? str(guest.drugAllergies) || 'Yes — see record' : null;

  return {
    template: TEMPLATES.includes(n.prescriptionTemplate) ? n.prescriptionTemplate : 'classic',
    guestName: str(guest.fullName) || 'Guest',
    guestCode: guestCodeOf(guest),
    age: ageOf(guest.dateOfBirth),
    gender: str(guest.gender) || null,
    allergies,
    centre: str(bk.preferredLocation) || null,
    visitDate: bk.confirmedDate || bk.preferredDate || null,
    issuedAt: n.completedAt || n.prescriptionSignedAt || n.createdAt || null,
    service: str(service && service.name) || str(bk.externalServiceName) || null,
    doctorName: str(doctorName) || str(n.doctorName) || null,
    signedBy: str(n.prescriptionSignedByName) || null,
    registration: str(n.prescriptionSignedByRegistration) || null,
    signed: Boolean(n.prescriptionSigned),
    signedAt: n.prescriptionSignedAt || null,
    diagnosis: { primary: str(n.primaryDiagnosis), secondary: str(n.secondaryDiagnosis) },
    complaint: str(n.complaint),
    examination: str(n.examination),
    assessment: str(n.assessment),
    plan: str(n.plan),
    items,
    assignedServices: (Array.isArray(n.assignedServices) ? n.assignedServices : []).map((s) => ({
      name: str(s && s.name),
      sessions: Number(s && s.sessions) > 0 ? Number(s.sessions) : 1,
    })),
    advice: {
      skinCare: str(n.skinCareAdvice),
      lifestyle: str(n.lifestyleAdvice),
      precautions: str(n.precautions),
    },
    followUpDate: n.followUpDate || null,
    hasScheduleH: items.some((i) => i.isScheduleH),
  };
}

/* --- Shared fragments -------------------------------------------------- */

const FONTS_LINK = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
  + '<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500&family=Manrope:wght@400;500;600;700&display=swap" rel="stylesheet">';


/* ------------------------------------------------------------------------ *
 * The logo.
 *
 * `logoDataUri(variant)` reads public/zennara-logo[-white].png once and returns
 * it as a data URI — right for anything rendered in a browser or printed.
 * `logoUrl(variant)` is the same file on the API's /assets route — right for
 * email, where most inboxes refuse data URIs but will fetch an https image.
 * Both fall back to the other so a missing env var or file never blanks the
 * header; the alt text carries the name if no image can be shown at all.
 * ------------------------------------------------------------------------ */
const LOGO_FILES = { green: 'zennara-logo.png', white: 'zennara-logo-white.png' };
const logoCache = new Map();
function logoDataUri(variant = 'green') {
  const key = LOGO_FILES[variant] ? variant : 'green';
  if (logoCache.has(key)) return logoCache.get(key);
  let uri = null;
  try {
    const file = require('path').join(__dirname, '..', 'public', LOGO_FILES[key]);
    uri = `data:image/png;base64,${require('fs').readFileSync(file).toString('base64')}`;
  } catch (_) { uri = null; }
  logoCache.set(key, uri);
  return uri;
}
function logoUrl(variant = 'green') {
  const base = String(process.env.API_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  const key = LOGO_FILES[variant] ? variant : 'green';
  return base ? `${base}/assets/${LOGO_FILES[key]}` : logoDataUri(key);
}
/** The <img> every template puts where the wordmark used to be. */
function logoTag(src, cls = 'rx-logo') {
  return src
    ? `<img class="${cls}" src="${src}" alt="Zennara" width="150">`
    : `<span class="${cls} rx-logo--text">Zennara</span>`;
}

const SERIF = "'Cormorant Garamond', 'Cormorant', Garamond, 'Times New Roman', serif";
const SANS = "'Manrope', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

/**
 * Print rules every design shares: A4, sane margins, and the Rx table never
 * split across a page — a pharmacist reading half a line on the next sheet is
 * a dispensing error waiting to happen.
 */
const PRINT_CSS = `
@page{size:A4;margin:14mm 14mm 16mm}
@media print{
  html,body{background:#fff!important}
  .rx-page{box-shadow:none!important;margin:0!important;max-width:none!important;min-height:0!important}
  .rx-table,.rx-table tr,.rx-block{page-break-inside:avoid;break-inside:avoid}
  .rx-ribbon{position:absolute}
}`;

/** The "not signed" ribbon; only a signed document may pass as a prescription. */
const RIBBON_CSS = `
.rx-ribbon{position:fixed;top:22px;right:-46px;z-index:9;transform:rotate(35deg);background:${BRAND.forest};color:#fff;font:600 11px/1 ${SANS};letter-spacing:.14em;text-transform:uppercase;padding:9px 56px;box-shadow:0 1px 0 rgba(0,0,0,.08)}`;

const ribbon = (draft) => (draft ? '<div class="rx-ribbon" role="note">Preview — not signed</div>' : '');

/** A guest-facing line: "Guest code · Age/Gender" style fragments. */
const ageGender = (view) => [view.age !== null && view.age !== undefined ? `${view.age} yrs` : null, view.gender].filter(Boolean).join(' / ');

const joinDots = (parts) => parts.filter(Boolean).map(esc).join(' · ');

/** The numbered medicine table shared by every design (styling is per-template). */
function itemsTable(view) {
  if (!view.items.length) return '<p class="rx-empty">No medicines were prescribed at this visit.</p>';
  const rows = view.items.map((it, i) => {
    const title = [it.medicine, it.strength, it.formulation].filter(Boolean).map(esc).join(' ');
    const regimen = joinDots([it.dosage, it.frequency, it.duration]);
    const second = joinDots([it.timing, it.instructions]);
    return `<tr>
      <td class="rx-n">${i + 1}</td>
      <td class="rx-med"><b>${title || '&mdash;'}</b>${it.isScheduleH ? ' <span class="rx-tag">Sch H</span>' : ''}${second ? `<div class="rx-sub">${second}</div>` : ''}</td>
      <td class="rx-reg">${regimen || '&mdash;'}</td>
    </tr>`;
  }).join('');
  return `<table class="rx-table"><thead><tr><th>#</th><th>Medicine</th><th>Dose · frequency · duration</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** Findings + diagnosis, only the parts that were written. */
function findings(view) {
  const rows = [
    ['Diagnosis', [view.diagnosis.primary, view.diagnosis.secondary].filter(Boolean).join('; ')],
    ['Complaint', view.complaint],
    ['Examination', view.examination],
    ['Assessment', view.assessment],
    ['Plan', view.plan],
  ].filter(([, v]) => v);
  if (!rows.length) return '';
  return `<dl class="rx-findings">${rows.map(([k, v]) => `<div class="rx-block"><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`;
}

function treatments(view) {
  if (!view.assignedServices.length) return '';
  return `<div class="rx-block"><h3>Treatments advised</h3><ul class="rx-list">${view.assignedServices
    .map((s) => `<li>${esc(s.name)}${s.sessions > 1 ? ` <span class="rx-dim">× ${s.sessions} sessions</span>` : ''}</li>`).join('')}</ul></div>`;
}

function advice(view) {
  const rows = [
    ['Skin care', view.advice.skinCare],
    ['Lifestyle', view.advice.lifestyle],
    ['Precautions', view.advice.precautions],
  ].filter(([, v]) => v);
  if (!rows.length) return '';
  return rows.map(([k, v]) => `<div class="rx-block"><h3>${k}</h3><p>${esc(v)}</p></div>`).join('');
}

const review = (view) => (view.followUpDate ? `<div class="rx-block rx-review"><h3>Review</h3><p>${esc(fmtDate(view.followUpDate))}</p></div>` : '');

function signature(view) {
  const name = view.signedBy || view.doctorName || 'Dermatologist';
  return `<div class="rx-sign rx-block">
    <div class="rx-sign__rule"></div>
    <b>${esc(name)}</b>
    <div>Consultant Dermatologist, Zennara</div>
    ${view.registration ? `<div>Reg. no. ${esc(view.registration)}</div>` : ''}
    ${view.signed && view.signedAt ? `<div class="rx-dim">Signed ${esc(fmtDateTime(view.signedAt))}</div>` : '<div class="rx-dim">Unsigned</div>'}
  </div>`;
}

function footer(view) {
  const schH = view.hasScheduleH
    ? '<p class="rx-schh">Schedule H — Warning: to be sold by retail on the prescription of a Registered Medical Practitioner only.</p>'
    : '';
  return `<footer class="rx-foot">${schH}<p>Issued electronically by Zennara Clinics after your consultation. Keep it for your records; a pharmacy can dispense from the printed or displayed copy.</p></footer>`;
}

const allergyLine = (view) => (view.allergies ? `<div class="rx-allergy"><b>Drug allergies:</b> ${esc(view.allergies)}</div>` : '');

const page = ({ title, css, body, draft }) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>${FONTS_LINK}
<style>${css}${RIBBON_CSS}${PRINT_CSS}</style></head>
<body>${ribbon(draft)}${body}</body></html>`;

/* --- Classic ----------------------------------------------------------- */

function classic(view, { draft, logo }) {
  const css = `
html,body{margin:0;background:${BRAND.sage}}
body{font:14px/1.5 ${SANS};color:${BRAND.ink}}
.rx-page{background:${BRAND.cream};max-width:760px;min-height:1000px;margin:24px auto;padding:44px 52px 36px;box-shadow:0 2px 14px rgba(31,42,34,.08);position:relative;overflow:hidden}
.rx-head{text-align:center;margin-bottom:22px}
.rx-mark{font:600 36px/1 ${SERIF};letter-spacing:.32em;color:${BRAND.forest};margin:0 0 8px;padding-left:.32em}
.rx-logo{display:block;width:150px;height:auto;margin:0 auto 10px}
.rx-logo--text{font:600 36px/1 ${SERIF};letter-spacing:.2em;color:${BRAND.forest}}
.rx-tag-line{font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:${BRAND.muted};margin:0}
.rx-centre{font-size:12px;color:${BRAND.muted};margin:6px 0 0}
.rx-guest{border-top:1px solid ${BRAND.forest};border-bottom:1px solid ${BRAND.forest};padding:12px 0;display:grid;grid-template-columns:1fr 1fr;gap:6px 24px;font-size:13px}
.rx-guest div span{display:block;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:${BRAND.muted}}
.rx-allergy{margin:10px 0 0;padding:8px 12px;background:${BRAND.sage};border-left:3px solid ${BRAND.forest};font-size:12.5px}
.rx-findings{margin:18px 0 0;padding:0}
.rx-findings dt{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:${BRAND.muted};margin:8px 0 2px}
.rx-findings dd{margin:0;white-space:pre-wrap}
.rx-rx{font:italic 500 46px/1 ${SERIF};color:${BRAND.forest};margin:26px 0 8px}
.rx-table{width:100%;border-collapse:collapse;font-size:13.5px}
.rx-table th{text-align:left;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:${BRAND.muted};font-weight:600;padding:6px 8px;border-bottom:1px solid ${BRAND.forest}}
.rx-table td{padding:9px 8px;border-bottom:1px solid rgba(44,62,47,.18);vertical-align:top}
.rx-n{width:22px;color:${BRAND.muted};font-variant-numeric:tabular-nums}
.rx-reg{width:36%;color:${BRAND.ink}}
.rx-sub{font-size:12px;color:${BRAND.muted};margin-top:2px}
.rx-tag{display:inline-block;font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:${BRAND.forest};border:1px solid ${BRAND.forest};border-radius:2px;padding:1px 5px;margin-left:6px;vertical-align:1px}
.rx-empty{color:${BRAND.muted};font-style:italic}
h3{font:600 11px/1.4 ${SANS};letter-spacing:.16em;text-transform:uppercase;color:${BRAND.forest};margin:20px 0 4px}
.rx-block p{margin:0;white-space:pre-wrap}
.rx-list{margin:0;padding-left:18px}
.rx-dim{color:${BRAND.muted}}
.rx-sign{margin-top:40px;text-align:right;font-size:13px}
.rx-sign__rule{width:220px;margin:0 0 6px auto;border-top:1px solid ${BRAND.forest}}
.rx-foot{margin-top:36px;padding-top:12px;border-top:1px solid rgba(44,62,47,.18);font-size:10.5px;color:${BRAND.muted}}
.rx-foot p{margin:0 0 4px}
.rx-schh{color:${BRAND.forest};font-weight:600}`;

  const body = `<main class="rx-page">
  <header class="rx-head">
    ${logoTag(logo.green)}
    <p class="rx-tag-line">Skin · Aesthetics · Wellness</p>
    ${view.centre ? `<p class="rx-centre">${esc(view.centre)}</p>` : ''}
  </header>
  <section class="rx-guest">
    <div><span>Guest</span>${esc(view.guestName)}</div>
    <div><span>Guest code</span>${esc(view.guestCode || '—')}</div>
    <div><span>Age / gender</span>${esc(ageGender(view) || '—')}</div>
    <div><span>Date</span>${esc(fmtDate(view.issuedAt || view.visitDate) || '—')}</div>
    <div><span>Dermatologist</span>${esc(view.doctorName || '—')}</div>
    <div><span>Service</span>${esc(view.service || 'Consultation')}</div>
  </section>
  ${allergyLine(view)}
  ${findings(view)}
  <div class="rx-rx" aria-label="Prescription">Rx</div>
  ${itemsTable(view)}
  ${treatments(view)}
  ${advice(view)}
  ${review(view)}
  ${signature(view)}
  ${footer(view)}
</main>`;

  return page({ title: `Prescription — ${view.guestName}`, css, body, draft });
}

/* --- Modern ------------------------------------------------------------ */

function modern(view, { draft, logo }) {
  const css = `
html,body{margin:0;background:${BRAND.sage}}
body{font:14px/1.5 ${SANS};color:${BRAND.ink}}
.rx-page{background:#fff;max-width:760px;min-height:1000px;margin:24px auto;box-shadow:0 2px 14px rgba(31,42,34,.08);position:relative;overflow:hidden}
.rx-band{background:${BRAND.forest};color:#fff;padding:26px 44px;display:flex;justify-content:space-between;align-items:flex-end;gap:16px}
.rx-mark{font:600 30px/1 ${SERIF};letter-spacing:.3em;margin:0;padding-left:.3em}
.rx-logo{display:block;width:132px;height:auto;margin:0}
.rx-logo--text{font:600 30px/1 ${SERIF};letter-spacing:.2em;color:#fff}
.rx-tag-line{font-size:10.5px;letter-spacing:.2em;text-transform:uppercase;opacity:.8;margin:8px 0 0}
.rx-band__right{text-align:right;font-size:12.5px;line-height:1.6;opacity:.95}
.rx-body{padding:26px 44px 32px}
.rx-meta{display:grid;grid-template-columns:1fr 1fr;gap:10px 28px;background:${BRAND.sage};padding:14px 18px;border-radius:4px;font-size:13px}
.rx-meta div span{display:block;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:${BRAND.muted}}
.rx-allergy{margin:10px 0 0;padding:8px 12px;border:1px solid ${BRAND.forest};border-radius:4px;font-size:12.5px}
h3,.rx-findings dt{font:700 10.5px/1.4 ${SANS};letter-spacing:.18em;text-transform:uppercase;color:${BRAND.forest};margin:22px 0 6px;padding-bottom:4px;border-bottom:1px solid ${BRAND.sage}}
.rx-findings{margin:0;padding:0}
.rx-findings dd{margin:0;white-space:pre-wrap}
.rx-table{width:100%;border-collapse:collapse;font-size:13.5px;margin-top:4px}
.rx-table th{text-align:left;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:${BRAND.muted};font-weight:700;padding:8px 10px;border-bottom:2px solid ${BRAND.forest}}
.rx-table td{padding:10px;vertical-align:top}
.rx-table tbody tr:nth-child(even) td{background:${BRAND.sage}}
.rx-n{width:22px;color:${BRAND.muted};font-variant-numeric:tabular-nums}
.rx-reg{width:36%}
.rx-sub{font-size:12px;color:${BRAND.muted};margin-top:2px}
.rx-tag{display:inline-block;font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:#fff;background:${BRAND.forest};border-radius:2px;padding:2px 6px;margin-left:6px;vertical-align:1px}
.rx-empty{color:${BRAND.muted};font-style:italic}
.rx-block p{margin:0;white-space:pre-wrap}
.rx-list{margin:0;padding-left:18px}
.rx-dim{color:${BRAND.muted}}
.rx-sign{margin-top:36px;margin-left:auto;width:260px;text-align:right;font-size:13px}
.rx-sign__rule{border-top:1px solid ${BRAND.forest};margin-bottom:6px}
.rx-foot{margin-top:32px;padding-top:12px;border-top:1px solid ${BRAND.sage};font-size:10.5px;color:${BRAND.muted}}
.rx-foot p{margin:0 0 4px}
.rx-schh{color:${BRAND.forest};font-weight:600}`;

  const body = `<main class="rx-page">
  <header class="rx-band">
    <div>${logoTag(logo.white)}<p class="rx-tag-line">Skin · Aesthetics · Wellness</p></div>
    <div class="rx-band__right">${view.centre ? `${esc(view.centre)}<br>` : ''}${esc(fmtDate(view.issuedAt || view.visitDate) || '')}</div>
  </header>
  <div class="rx-body">
    <section class="rx-meta">
      <div><span>Guest</span>${esc(view.guestName)}</div>
      <div><span>Guest code</span>${esc(view.guestCode || '—')}</div>
      <div><span>Age / gender</span>${esc(ageGender(view) || '—')}</div>
      <div><span>Dermatologist</span>${esc(view.doctorName || '—')}</div>
      <div><span>Service</span>${esc(view.service || 'Consultation')}</div>
      <div><span>Visit</span>${esc(fmtDate(view.visitDate) || '—')}</div>
    </section>
    ${allergyLine(view)}
    ${findings(view)}
    <h3>Prescription</h3>
    ${itemsTable(view)}
    ${treatments(view)}
    ${advice(view)}
    ${review(view)}
    ${signature(view)}
    ${footer(view)}
  </div>
</main>`;

  return page({ title: `Prescription — ${view.guestName}`, css, body, draft });
}

/* --- Minimal ----------------------------------------------------------- */

function minimal(view, { draft, logo }) {
  const css = `
html,body{margin:0;background:#fff}
body{font:12.5px/1.45 ${SANS};color:${BRAND.ink}}
.rx-page{max-width:720px;margin:0 auto;padding:28px 32px;position:relative;overflow:hidden}
.rx-top{display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px solid ${BRAND.ink};padding-bottom:8px}
.rx-mark{font:600 20px/1 ${SERIF};letter-spacing:.28em;margin:0}
.rx-logo{display:block;width:96px;height:auto;margin:0}
.rx-logo--text{font:600 20px/1 ${SERIF};letter-spacing:.2em;color:${BRAND.ink}}
.rx-top__right{font-size:11.5px;color:${BRAND.muted};text-align:right}
.rx-guest{display:flex;flex-wrap:wrap;gap:4px 18px;padding:8px 0;border-bottom:1px solid ${BRAND.ink};font-size:12px}
.rx-guest b{font-weight:600}
.rx-allergy{margin:8px 0 0;font-size:12px}
.rx-findings{margin:8px 0 0;padding:0}
.rx-findings dt{display:inline;font-weight:600}
.rx-findings dt::after{content:": "}
.rx-findings dd{display:inline;margin:0;white-space:pre-wrap}
.rx-findings .rx-block{margin:2px 0}
h3{font:600 11px/1.4 ${SANS};letter-spacing:.12em;text-transform:uppercase;margin:14px 0 3px}
.rx-table{width:100%;border-collapse:collapse;font-size:12.5px}
.rx-table th{text-align:left;font-weight:600;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;padding:4px 6px;border-bottom:1px solid ${BRAND.ink}}
.rx-table td{padding:5px 6px;border-bottom:1px solid rgba(31,42,34,.2);vertical-align:top}
.rx-n{width:18px;color:${BRAND.muted}}
.rx-reg{width:38%}
.rx-sub{font-size:11.5px;color:${BRAND.muted}}
.rx-tag{font-size:10px;letter-spacing:.08em;text-transform:uppercase;border:1px solid ${BRAND.ink};padding:0 4px;margin-left:5px}
.rx-empty{color:${BRAND.muted};font-style:italic}
.rx-block p{margin:0;white-space:pre-wrap}
.rx-list{margin:0;padding-left:16px}
.rx-dim{color:${BRAND.muted}}
.rx-sign{margin-top:28px;text-align:right;font-size:12px}
.rx-sign__rule{width:200px;margin:0 0 4px auto;border-top:1px solid ${BRAND.ink}}
.rx-foot{margin-top:20px;padding-top:6px;border-top:1px solid rgba(31,42,34,.2);font-size:10px;color:${BRAND.muted}}
.rx-foot p{margin:0 0 3px}
.rx-schh{color:${BRAND.ink};font-weight:600}`;

  const body = `<main class="rx-page">
  <header class="rx-top">
    ${logoTag(logo.green)}
    <div class="rx-top__right">${view.centre ? `${esc(view.centre)} · ` : ''}${esc(fmtDate(view.issuedAt || view.visitDate) || '')}</div>
  </header>
  <section class="rx-guest">
    <div><b>${esc(view.guestName)}</b></div>
    ${view.guestCode ? `<div>${esc(view.guestCode)}</div>` : ''}
    ${ageGender(view) ? `<div>${esc(ageGender(view))}</div>` : ''}
    ${view.doctorName ? `<div>Dr: ${esc(view.doctorName)}</div>` : ''}
    ${view.service ? `<div>${esc(view.service)}</div>` : ''}
  </section>
  ${allergyLine(view)}
  ${findings(view)}
  <h3>Rx</h3>
  ${itemsTable(view)}
  ${treatments(view)}
  ${advice(view)}
  ${review(view)}
  ${signature(view)}
  ${footer(view)}
</main>`;

  return page({ title: `Prescription — ${view.guestName}`, css, body, draft });
}

const RENDERERS = { classic, modern, minimal };

/**
 * The complete standalone document. `template` defaults to the note's own
 * choice; `draft` defaults to "not yet signed" and stamps the preview ribbon,
 * so an unsigned sheet can never be mistaken for a prescription.
 */
function renderPrescriptionHtml(view, {
  template = view && view.template,
  draft = !(view && view.signed),
  // Inlined by default, so a preview, a download or a print job needs no
  // network. The email passes the hosted URLs instead (see logoUrl).
  logo = { green: logoDataUri('green'), white: logoDataUri('white') },
} = {}) {
  const key = TEMPLATES.includes(template) ? template : 'classic';
  return RENDERERS[key](view || buildView({}), { draft: Boolean(draft), logo: logo || {} });
}

module.exports = {
  TEMPLATES,
  templateMeta,
  buildView,
  renderPrescriptionHtml,
  logoDataUri,
  logoUrl,
  esc,
  fmtDate,
  daysFromDuration,
  refillDueAt,
};
