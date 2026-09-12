/**
 * The prescription as a PDF — the copy that leaves the building.
 *
 * Until 2026-09-12 the guest received the prescription as an HTML attachment,
 * which most phones open as a page of raw markup and no pharmacy could print.
 * The clinic's rule now: signing delivers a PDF, by email and by WhatsApp,
 * with no manual "send" anywhere. This module draws that PDF.
 *
 * It reads the SAME view utils/prescriptionTemplates builds for the HTML
 * sheet, in the same content order and the same three designs, so the panel
 * preview, the app's page and the file on the guest's phone are one document.
 * Every word is set in Poppins, embedded from public/fonts so the file looks
 * the same on a phone with no fonts installed; Dancing Script is embedded for
 * one thing only — the signing dermatologist's name drawn as a signature.
 *
 * pdfkit lays text out on a cursor we manage ourselves (`sheet`), because a
 * table row split across two pages — half a dosage on the next sheet — is a
 * dispensing error waiting to happen. Every block measures itself, moves to a
 * new page when it would not fit, and the Rx table repeats its header there.
 *
 * The share-token helpers live here too: a signed, expiring link to the PDF
 * is what Twilio fetches for the WhatsApp document and what the app shares.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const {
  TEMPLATES, buildView, fmtDate, fmtDateTime, SCHEDULE_H_TAG, BRAND,
} = require('./prescriptionTemplates');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/* --- Embedded assets --------------------------------------------------- */

const FONT_FILES = {
  regular: 'Poppins-Regular.ttf',
  medium: 'Poppins-Medium.ttf',
  semibold: 'Poppins-SemiBold.ttf',
  bold: 'Poppins-Bold.ttf',
  italic: 'Poppins-Italic.ttf',
  script: 'DancingScript-Regular.ttf',
};
const LOGO_FILES = { green: 'zennara-logo.png', white: 'zennara-logo-white.png' };
/** The logo PNGs are 525×315; the drawn height follows the width. */
const LOGO_RATIO = 315 / 525;

/*
 * Read once per process, never per document: a signature fires two renders
 * (email + WhatsApp share the buffer, but the panel preview and the app each
 * ask again) and the fonts alone are ~1 MB. A missing file yields null and the
 * renderer falls back to Helvetica / a typed wordmark rather than throwing —
 * a font on the wrong server must never stop a prescription reaching a guest.
 */
const assetCache = new Map();
function asset(sub, file) {
  const key = `${sub}/${file}`;
  if (assetCache.has(key)) return assetCache.get(key);
  let buf = null;
  try { buf = fs.readFileSync(path.join(PUBLIC_DIR, sub, file)); } catch (_) { buf = null; }
  assetCache.set(key, buf);
  return buf;
}

/** Register the faces on a document; returns the names to use with doc.font(). */
function registerFonts(doc) {
  const names = {};
  for (const [key, file] of Object.entries(FONT_FILES)) {
    const buf = asset('fonts', file);
    if (buf) {
      const name = `Rx-${key}`;
      doc.registerFont(name, buf);
      names[key] = name;
    } else {
      names[key] = key === 'bold' || key === 'semibold' ? 'Helvetica-Bold' : key === 'italic' ? 'Helvetica-Oblique' : 'Helvetica';
    }
  }
  return names;
}

/* --- Designs ----------------------------------------------------------- */

/*
 * One style object per template. The numbers are the HTML templates' CSS
 * scaled to points (a 760px page becomes a 595pt A4 sheet, ~0.7), so the
 * PDF and the panel's on-screen sheet have the same proportions.
 */
const STYLES = {
  classic: {
    variant: 'classic',
    paper: BRAND.cream,
    margin: { top: 40, right: 52, bottom: 44, left: 52 },
    body: 9.5, small: 8.2, label: { size: 6.4, spacing: 0.9, color: BRAND.muted },
    h3: { size: 7.4, spacing: 1.2, color: BRAND.forest, rule: null, top: 14, bottom: 3 },
    table: { pad: 6, headRule: { color: BRAND.forest, width: 0.8 }, rowRule: 'rgba', zebra: null, headColor: BRAND.muted },
    tag: { fill: null, stroke: BRAND.forest, fg: BRAND.forest },
    sign: { top: 28, scriptColor: BRAND.forest, ruleColor: BRAND.forest },
    ribbon: { bg: BRAND.forest, fg: '#ffffff' },
    foot: { top: 26, rule: BRAND.forest, schh: BRAND.forest },
  },
  modern: {
    variant: 'modern',
    paper: '#ffffff',
    margin: { top: 36, right: 44, bottom: 40, left: 44 },
    body: 9.5, small: 8.2, label: { size: 6.4, spacing: 0.9, color: BRAND.muted },
    h3: { size: 7.2, spacing: 1.3, color: BRAND.forest, rule: BRAND.sage, top: 16, bottom: 6 },
    table: { pad: 7, headRule: { color: BRAND.forest, width: 1.4 }, rowRule: null, zebra: BRAND.sage, headColor: BRAND.muted },
    tag: { fill: BRAND.forest, stroke: null, fg: '#ffffff' },
    sign: { top: 26, scriptColor: BRAND.forest, ruleColor: BRAND.forest },
    ribbon: { bg: BRAND.sage, fg: BRAND.forest },
    foot: { top: 24, rule: BRAND.sage, schh: BRAND.forest },
    band: 104,
  },
  minimal: {
    variant: 'minimal',
    paper: '#ffffff',
    margin: { top: 30, right: 36, bottom: 36, left: 36 },
    body: 9, small: 8, label: { size: 6.6, spacing: 0.7, color: BRAND.ink },
    h3: { size: 7.4, spacing: 0.9, color: BRAND.ink, rule: null, top: 11, bottom: 2 },
    table: { pad: 4, headRule: { color: BRAND.ink, width: 0.7 }, rowRule: 'rgba', zebra: null, headColor: BRAND.ink },
    tag: { fill: null, stroke: BRAND.ink, fg: BRAND.ink },
    sign: { top: 20, scriptColor: BRAND.ink, ruleColor: BRAND.ink },
    ribbon: { bg: BRAND.forest, fg: '#ffffff' },
    foot: { top: 16, rule: BRAND.ink, schh: BRAND.ink },
  },
};

/** The light rule between table rows / above the footer: the brand ink at ~20%. */
const FAINT_RULE = '#cdd3ce';

/* --- The sheet: a cursor over A4 pages ---------------------------------- */

/**
 * Wraps a PDFDocument with a y cursor, the content box and the per-page
 * furniture (paper colour, the preview ribbon, a continuation strip).
 * `ensure(h)` is the page-break rule: nothing is drawn where it cannot fit.
 */
function makeSheet(doc, S, { draft }) {
  const W = doc.page.width;
  const H = doc.page.height;
  const sh = {
    doc,
    W,
    H,
    L: S.margin.left,
    R: W - S.margin.right,
    BOTTOM: H - S.margin.bottom,
    y: S.margin.top,
    fonts: registerFonts(doc),
    first: true,
  };
  sh.CW = sh.R - sh.L;

  sh.font = (key, size, color) => {
    doc.font(sh.fonts[key] || sh.fonts.regular).fontSize(size);
    if (color) doc.fillColor(color);
    return sh;
  };
  sh.rule = (x1, x2, color, width = 0.6, y = sh.y) => {
    doc.save().moveTo(x1, y).lineTo(x2, y).lineWidth(width).strokeColor(color).stroke().restore();
  };
  sh.gap = (h) => { sh.y += h; };
  sh.ensure = (h) => { if (sh.y + h > sh.BOTTOM) doc.addPage(); };
  /** Draw a paragraph at the cursor and advance past it. */
  sh.text = (str, x, w, opts = {}) => {
    doc.text(String(str), x, sh.y, { width: w, lineGap: 1.2, ...opts });
    sh.y = doc.y;
  };
  /** Height of a paragraph in the current font, for ensure(). */
  sh.height = (str, w, opts = {}) => doc.heightOfString(String(str), { width: w, lineGap: 1.2, ...opts });

  const ribbon = () => {
    doc.save();
    doc.translate(W - 60, 56).rotate(35);
    doc.rect(-150, -11, 300, 22).lineWidth(0.8).fillAndStroke(S.ribbon.bg, BRAND.forest);
    sh.font('semibold', 7.5, S.ribbon.fg);
    doc.text('PREVIEW — NOT SIGNED', -150, -4.6, { width: 300, align: 'center', characterSpacing: 1.8, lineBreak: false });
    doc.restore();
  };

  const paint = (first) => {
    if (S.paper !== '#ffffff') doc.rect(0, 0, W, H).fill(S.paper);
    // A continuation page of the modern design keeps a sliver of its band, so
    // page two still reads as the same document without repeating the header.
    if (!first && S.band) doc.rect(0, 0, W, 6).fill(BRAND.forest);
    if (draft) ribbon();
    doc.fillColor(BRAND.ink);
  };

  paint(true);
  doc.on('pageAdded', () => {
    sh.first = false;
    sh.y = S.margin.top;
    paint(false);
  });
  return sh;
}

/* --- Shared blocks ------------------------------------------------------ */

const ageGender = (view) => [view.age !== null && view.age !== undefined ? `${view.age} yrs` : null, view.gender].filter(Boolean).join(' / ');
const dots = (parts) => parts.filter(Boolean).join(' · ');

/** Small uppercase label — the "GUEST CODE" over a value. */
function label(sh, S, str, x, w, opts = {}) {
  sh.font('semibold', S.label.size, S.label.color);
  sh.doc.text(String(str).toUpperCase(), x, sh.y, { width: w, characterSpacing: S.label.spacing, lineBreak: false, ...opts });
}

function heading(sh, S, str) {
  sh.gap(S.h3.top);
  sh.ensure(22);
  sh.font('semibold', S.h3.size, S.h3.color);
  sh.text(String(str).toUpperCase(), sh.L, sh.CW, { characterSpacing: S.h3.spacing, lineBreak: false });
  if (S.h3.rule) { sh.gap(2); sh.rule(sh.L, sh.R, S.h3.rule, 0.8); }
  sh.gap(S.h3.bottom);
}

/** A section heading followed by a paragraph; kept together where possible. */
function section(sh, S, title, body) {
  if (!body) return;
  sh.font('regular', S.body);
  const h = sh.height(body, sh.CW);
  sh.ensure(Math.min(h, 120) + 26);
  heading(sh, S, title);
  sh.font('regular', S.body, BRAND.ink);
  sh.text(body, sh.L, sh.CW);
}

function logo(sh, variant, x, y, width) {
  const buf = asset('', LOGO_FILES[variant] || LOGO_FILES.green);
  const h = width * LOGO_RATIO;
  if (buf) {
    sh.doc.image(buf, x, y, { width });
  } else {
    sh.font('semibold', width / 5, variant === 'white' ? '#ffffff' : BRAND.forest);
    sh.doc.text('ZENNARA', x, y + h / 3, { width, characterSpacing: 3, lineBreak: false });
  }
  return h;
}

/** Two-column label/value grid (classic and modern). */
function guestGrid(sh, S, cells, { box = null } = {}) {
  const { doc } = sh;
  const padX = box ? 14 : 0;
  const padY = box ? 11 : 10;
  const colW = (sh.CW - padX * 2 - 20) / 2;
  const rows = [];
  for (let i = 0; i < cells.length; i += 2) rows.push(cells.slice(i, i + 2));
  sh.font('regular', S.body);
  const rowHeights = rows.map((row) => Math.max(...row.map(([, v]) => sh.height(v, colW))) + S.label.size + 5);
  const total = rowHeights.reduce((a, b) => a + b, 0) + padY * 2 + (rows.length - 1) * 4;
  sh.ensure(total);
  const top = sh.y;
  if (box) {
    doc.roundedRect(sh.L, top, sh.CW, total, 3).fill(box);
  } else {
    sh.rule(sh.L, sh.R, BRAND.forest, 0.8, top);
  }
  sh.y = top + padY;
  rows.forEach((row, r) => {
    const startY = sh.y;
    row.forEach(([k, v], c) => {
      const x = sh.L + padX + c * (colW + 20);
      sh.y = startY;
      label(sh, S, k, x, colW);
      sh.y = startY + S.label.size + 4;
      sh.font('regular', S.body, BRAND.ink);
      sh.text(v, x, colW);
    });
    sh.y = startY + rowHeights[r] + (r < rows.length - 1 ? 4 : 0);
  });
  sh.y = top + total;
  if (!box) sh.rule(sh.L, sh.R, BRAND.forest, 0.8, sh.y);
}

function allergy(sh, S, view) {
  if (!view.allergies) return;
  const { doc } = sh;
  const line = `Drug allergies: ${view.allergies}`;
  sh.gap(8);
  sh.font('regular', S.small);
  const inner = sh.CW - 20;
  const h = sh.height(line, inner) + 12;
  sh.ensure(h);
  if (S.variant === 'classic') {
    doc.rect(sh.L, sh.y, sh.CW, h).fill(BRAND.sage);
    doc.rect(sh.L, sh.y, 2.2, h).fill(BRAND.forest);
  } else if (S.variant === 'modern') {
    doc.roundedRect(sh.L + 0.5, sh.y + 0.5, sh.CW - 1, h - 1, 3).lineWidth(0.8).stroke(BRAND.forest);
  }
  const top = sh.y;
  sh.y = top + 6;
  const x = S.variant === 'minimal' ? sh.L : sh.L + 10;
  sh.font('semibold', S.small, BRAND.ink);
  doc.text('Drug allergies: ', x, sh.y, { width: inner, continued: true, lineGap: 1.2 });
  sh.font('regular', S.small, BRAND.ink);
  doc.text(view.allergies);
  sh.y = S.variant === 'minimal' ? doc.y : top + h;
}

/** Diagnosis, complaint, examination, assessment, plan — only what was written. */
function findings(sh, S, view) {
  const rows = [
    ['Diagnosis', [view.diagnosis.primary, view.diagnosis.secondary].filter(Boolean).join('; ')],
    ['Complaint', view.complaint],
    ['Examination', view.examination],
    ['Assessment', view.assessment],
    ['Plan', view.plan],
  ].filter(([, v]) => v);
  if (!rows.length) return;
  const { doc } = sh;
  sh.gap(S.variant === 'minimal' ? 6 : 10);
  for (const [k, v] of rows) {
    sh.font('regular', S.body);
    if (S.variant === 'minimal') {
      const h = sh.height(`${k}: ${v}`, sh.CW);
      sh.ensure(Math.min(h, 100));
      sh.font('semibold', S.body, BRAND.ink);
      doc.text(`${k}: `, sh.L, sh.y, { width: sh.CW, continued: true, lineGap: 1.2 });
      sh.font('regular', S.body, BRAND.ink);
      doc.text(v);
      sh.y = doc.y + 1.5;
    } else {
      const h = sh.height(v, sh.CW);
      sh.ensure(Math.min(h, 100) + 16);
      if (S.variant === 'modern') {
        heading(sh, S, k);
      } else {
        label(sh, S, k, sh.L, sh.CW);
        sh.y += S.label.size + 4;
      }
      sh.font('regular', S.body, BRAND.ink);
      sh.text(v, sh.L, sh.CW);
      sh.gap(S.variant === 'modern' ? 0 : 5);
    }
  }
}

/** The "Schedule H · prescription only" mark on a line. Returns its height. */
function tag(sh, S, x, y, text) {
  const { doc } = sh;
  const spacing = 0.55;
  const size = 5.9;
  const h = 11;
  sh.font('medium', size, S.tag.fg);
  const t = String(text).toUpperCase();
  const w = doc.widthOfString(t, { characterSpacing: spacing }) + 10;
  if (S.tag.fill) {
    doc.roundedRect(x, y, w, h, 1.5).fill(S.tag.fill);
  } else {
    doc.roundedRect(x + 0.4, y + 0.4, w - 0.8, h - 0.8, 1.5).lineWidth(0.6).stroke(S.tag.stroke);
  }
  sh.font('medium', size, S.tag.fg);
  doc.text(t, x + 5, y + 2.7, { width: w, characterSpacing: spacing, lineBreak: false });
  return h;
}

/**
 * The numbered Rx table. Rows are measured before they are drawn and moved
 * whole to the next page, where the header is drawn again.
 */
function rxTable(sh, S, view) {
  const { doc } = sh;
  if (!view.items.length) {
    sh.ensure(16);
    sh.font('italic', S.body, BRAND.muted);
    sh.text('No medicines were prescribed at this visit.', sh.L, sh.CW);
    return;
  }
  const nW = 16;
  const gutter = 8;
  const regW = Math.round(sh.CW * 0.34);
  const medX = sh.L + nW + gutter;
  const medW = sh.CW - nW - gutter - regW - gutter;
  const regX = sh.R - regW;
  const pad = S.table.pad;

  const header = () => {
    sh.font('semibold', S.label.size, S.table.headColor);
    const opts = { characterSpacing: S.label.spacing, lineBreak: false };
    doc.text('#', sh.L, sh.y, { width: nW, ...opts });
    doc.text('MEDICINE', medX, sh.y, { width: medW, ...opts });
    doc.text('DOSE · FREQUENCY · DURATION', regX, sh.y, { width: regW, ...opts });
    sh.y += S.label.size + 5;
    sh.rule(sh.L, sh.R, S.table.headRule.color, S.table.headRule.width);
    sh.y += 1;
  };

  sh.ensure(44);
  header();
  view.items.forEach((it, i) => {
    const title = [it.medicine, it.strength, it.formulation].filter(Boolean).join(' ') || '—';
    const second = dots([it.timing, it.instructions]);
    const regimen = dots([it.dosage, it.frequency, it.duration]) || '—';

    sh.font('semibold', S.body);
    const titleH = sh.height(title, medW);
    const tagH = it.isScheduleH ? 14 : 0;
    let subH = 0;
    if (second) { sh.font('regular', S.small); subH = sh.height(second, medW) + 1.5; }
    sh.font('regular', S.body);
    const regH = sh.height(regimen, regW);
    const rowH = Math.max(titleH + tagH + subH, regH) + pad * 2;

    if (sh.y + rowH > sh.BOTTOM) { doc.addPage(); header(); }
    if (S.table.zebra && i % 2 === 1) doc.rect(sh.L, sh.y, sh.CW, rowH).fill(S.table.zebra);

    const top = sh.y;
    const cy = top + pad;
    sh.font('regular', S.body, BRAND.muted);
    doc.text(String(i + 1), sh.L, cy, { width: nW, lineBreak: false });
    sh.font('semibold', S.body, BRAND.ink);
    doc.text(title, medX, cy, { width: medW, lineGap: 1.2 });
    let my = cy + titleH;
    if (it.isScheduleH) { tag(sh, S, medX, my + 1.5, SCHEDULE_H_TAG); my += tagH; }
    if (second) {
      sh.font('regular', S.small, BRAND.muted);
      doc.text(second, medX, my + 1, { width: medW, lineGap: 1.2 });
    }
    sh.font('regular', S.body, BRAND.ink);
    doc.text(regimen, regX, cy, { width: regW, lineGap: 1.2 });

    sh.y = top + rowH;
    if (S.table.rowRule) sh.rule(sh.L, sh.R, FAINT_RULE, 0.5);
  });
}

function treatments(sh, S, view) {
  if (!view.assignedServices.length) return;
  sh.font('regular', S.body);
  const lines = view.assignedServices.map((s) => `${s.name}${s.sessions > 1 ? `  ×  ${s.sessions} sessions` : ''}`);
  sh.ensure(26 + lines.length * (S.body + 4));
  heading(sh, S, 'Treatments advised');
  for (const line of lines) {
    sh.ensure(S.body + 4);
    sh.font('regular', S.body, BRAND.muted);
    sh.doc.text('•', sh.L + 2, sh.y, { width: 10, lineBreak: false });
    sh.font('regular', S.body, BRAND.ink);
    sh.text(line, sh.L + 12, sh.CW - 12);
    sh.gap(1);
  }
}

function advice(sh, S, view) {
  section(sh, S, 'Skin care', view.advice.skinCare);
  section(sh, S, 'Lifestyle', view.advice.lifestyle);
  section(sh, S, 'Precautions', view.advice.precautions);
}

function review(sh, S, view) {
  if (!view.followUpDate) return;
  section(sh, S, 'Review', fmtDate(view.followUpDate) || '—');
}

/**
 * The signature block, right-aligned. Signed: the dermatologist's name in the
 * script face sitting on the rule, then the printed name, title and
 * registration. Draft (or a signed note rendered as a preview): the rule and
 * "Unsigned" — a preview must never look signed.
 */
function signature(sh, S, view, draft) {
  const { doc } = sh;
  const colW = 200;
  const x = sh.R - colW;
  const signed = view.signed && !draft;
  const name = view.signedBy || view.doctorName || 'Dermatologist';
  const script = signed && view.signatureText ? view.signatureText : null;
  const lineH = S.small + 3.5;
  const blockH = (script ? 34 : 0) + 6 + (S.body + 4) + lineH * (2 + (view.registration ? 1 : 0)) + 4;

  sh.gap(S.sign.top);
  sh.ensure(blockH);
  if (script) {
    sh.font('script', 23, S.sign.scriptColor);
    doc.text(script, x - 60, sh.y, { width: colW + 60, align: 'right', lineBreak: false });
    sh.y += 32;
  }
  sh.rule(x, sh.R, S.sign.ruleColor, 0.8);
  sh.y += 5;
  const right = (str, key, size, color) => {
    sh.font(key, size, color);
    doc.text(str, x - 60, sh.y, { width: colW + 60, align: 'right', lineBreak: false });
    sh.y += size + 3.5;
  };
  right(name, 'semibold', S.body, BRAND.ink);
  right('Consultant Dermatologist, Zennara', 'regular', S.small, BRAND.ink);
  if (view.registration) right(`Reg. No. ${view.registration}`, 'regular', S.small, BRAND.ink);
  right(signed && view.signedAt ? `Signed ${fmtDateTime(view.signedAt)}` : 'Unsigned', 'regular', S.small, BRAND.muted);
}

function footer(sh, S, view) {
  const schh = view.hasScheduleH
    ? 'Schedule H — Warning: to be sold by retail on the prescription of a Registered Medical Practitioner only.'
    : null;
  const issued = 'Issued electronically by Zennara Clinics after your consultation. Keep it for your records; a pharmacy can dispense from the printed or displayed copy.';
  sh.font('regular', 7.4);
  const h = (schh ? sh.height(schh, sh.CW) + 3 : 0) + sh.height(issued, sh.CW) + 12;
  sh.gap(S.foot.top);
  sh.ensure(h);
  sh.rule(sh.L, sh.R, S.variant === 'classic' ? FAINT_RULE : S.foot.rule, S.variant === 'minimal' ? 0.5 : 0.7);
  sh.y += 8;
  if (schh) {
    sh.font('semibold', 7.4, S.foot.schh);
    sh.text(schh, sh.L, sh.CW);
    sh.gap(3);
  }
  sh.font('regular', 7.4, BRAND.muted);
  sh.text(issued, sh.L, sh.CW);
}

/* --- Headers per design ------------------------------------------------- */

function classicHeader(sh, S, view) {
  const { doc } = sh;
  const w = 108;
  const h = logo(sh, 'green', (sh.W - w) / 2, sh.y, w);
  // The artwork carries "Skin · Aesthetics · Wellness" beneath the mark, so
  // nothing is set under it — an earlier cut printed the tagline twice.
  sh.y += h + 8;
  if (view.centre) {
    sh.gap(3);
    sh.font('regular', 8.4, BRAND.muted);
    sh.text(view.centre, sh.L, sh.CW, { align: 'center' });
  }
  sh.gap(16);
  doc.fillColor(BRAND.ink);
  guestGrid(sh, S, [
    ['Guest', view.guestName],
    ['Guest code', view.guestCode || '—'],
    ['Age / gender', ageGender(view) || '—'],
    ['Date', fmtDate(view.issuedAt || view.visitDate) || '—'],
    ['Dermatologist', view.doctorName || '—'],
    ['Service', view.service || 'Consultation'],
  ]);
}

function modernHeader(sh, S, view) {
  const { doc } = sh;
  const band = S.band;
  doc.rect(0, 0, sh.W, band).fill(BRAND.forest);
  logo(sh, 'white', sh.L, 20, 96); // the mark carries its own tagline
  const rightW = 240;
  sh.font('regular', 8.8, '#ffffff');
  const lines = [view.centre, fmtDate(view.issuedAt || view.visitDate)].filter(Boolean);
  lines.forEach((line, i) => {
    doc.text(line, sh.R - rightW, band - 24 - (lines.length - 1 - i) * 13, { width: rightW, align: 'right', lineBreak: false });
  });
  sh.y = band + 22;
  doc.fillColor(BRAND.ink);
  guestGrid(sh, S, [
    ['Guest', view.guestName],
    ['Guest code', view.guestCode || '—'],
    ['Age / gender', ageGender(view) || '—'],
    ['Dermatologist', view.doctorName || '—'],
    ['Service', view.service || 'Consultation'],
    ['Visit', fmtDate(view.visitDate) || '—'],
  ], { box: BRAND.sage });
}

function minimalHeader(sh, S, view) {
  const { doc } = sh;
  const top = sh.y;
  const h = logo(sh, 'green', sh.L, top, 70);
  sh.font('regular', 8.2, BRAND.muted);
  const right = dots([view.centre, fmtDate(view.issuedAt || view.visitDate)]);
  if (right) doc.text(right, sh.L + 90, top + h - 12, { width: sh.CW - 90, align: 'right', lineBreak: false });
  sh.y = top + h + 6;
  sh.rule(sh.L, sh.R, BRAND.ink, 0.7);
  sh.y += 6;
  // One line, the name bold, the rest plain — the compact guest strip.
  const rest = dots([view.guestCode, ageGender(view), view.doctorName || null, view.service]);
  sh.font('semibold', S.body, BRAND.ink);
  doc.text(view.guestName, sh.L, sh.y, { width: sh.CW, continued: Boolean(rest), lineGap: 1.2 });
  if (rest) {
    sh.font('regular', S.body, BRAND.ink);
    doc.text(`   ·   ${rest}`);
  }
  sh.y = doc.y + 6;
  sh.rule(sh.L, sh.R, BRAND.ink, 0.7);
}

const HEADERS = { classic: classicHeader, modern: modernHeader, minimal: minimalHeader };

/** The "Rx" / "Prescription" heading that opens the table, per design. */
function rxHeading(sh, S) {
  if (S.variant === 'classic') {
    sh.gap(14);
    sh.ensure(40);
    sh.font('italic', 32, BRAND.forest);
    sh.doc.text('Rx', sh.L, sh.y, { width: 80, lineBreak: false });
    sh.y += 42;
  } else if (S.variant === 'modern') {
    heading(sh, S, 'Prescription');
  } else {
    heading(sh, S, 'Rx');
  }
}

/* --- Entry point --------------------------------------------------------- */

/**
 * Render the view as an A4 PDF. `template` defaults to the note's own choice;
 * `draft` defaults to "not yet signed" and stamps the preview ribbon on every
 * page, so an unsigned sheet can never be mistaken for a prescription.
 */
function renderPrescriptionPdf(view, { template = view && view.template, draft = !(view && view.signed) } = {}) {
  const v = view || buildView({});
  const key = TEMPLATES.includes(template) ? template : 'classic';
  const S = STYLES[key];
  const isDraft = Boolean(draft);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { ...S.margin },
      autoFirstPage: true,
      bufferPages: false,
      info: {
        Title: `Prescription — ${v.guestName}`,
        Author: 'Zennara Clinics',
        Subject: isDraft ? 'Prescription preview (not signed)' : 'Prescription',
        Creator: 'Zennara',
      },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      const sh = makeSheet(doc, S, { draft: isDraft });
      HEADERS[key](sh, S, v);
      allergy(sh, S, v);
      findings(sh, S, v);
      rxHeading(sh, S);
      rxTable(sh, S, v);
      treatments(sh, S, v);
      advice(sh, S, v);
      review(sh, S, v);
      signature(sh, S, v, isDraft);
      footer(sh, S, v);
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

/** "prescription-asha-rao-2026-09-03.pdf" — the attachment / download name. */
function prescriptionFilename(view) {
  const slug = String((view && view.guestName) || 'guest').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'guest';
  const when = (view && (view.issuedAt || view.visitDate)) || null;
  let day = '';
  if (when) {
    const d = new Date(when);
    if (!Number.isNaN(d.getTime())) day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  }
  return `prescription-${slug}${day ? `-${day}` : ''}.pdf`;
}

/* --- Share links ---------------------------------------------------------
 *
 * Twilio has to fetch the WhatsApp document over plain https with no session,
 * and the guest may forward the same link from the app. So the PDF is served
 * on a public route behind a token that is signed (nobody can mint one for
 * another note), expiring (a forwarded link goes dead after a week) and bound
 * to one note. Token = base64url("<noteId>.<exp>.<hmac>") where hmac is
 * HMAC-SHA256("<noteId>.<exp>", JWT_SECRET) in hex. Compared in constant time.
 * ------------------------------------------------------------------------ */

const SHARE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const secret = () => String(process.env.JWT_SECRET || '');
const mac = (payload) => crypto.createHmac('sha256', secret()).update(payload).digest('hex');

function makeShareToken(noteId, { ttlMs = SHARE_TTL_MS, now = Date.now() } = {}) {
  if (!secret()) throw new Error('JWT_SECRET is not set; cannot sign a prescription share link');
  const id = String(noteId);
  if (!/^[a-f0-9]{24}$/i.test(id)) throw new Error('A share link needs a note id');
  const exp = Math.floor(now + ttlMs);
  const payload = `${id}.${exp}`;
  return {
    token: Buffer.from(`${payload}.${mac(payload)}`, 'utf8').toString('base64url'),
    expiresAt: new Date(exp),
  };
}

/** → { noteId, expiresAt } for a valid, unexpired token; null for anything else. */
function verifyShareToken(token, { now = Date.now() } = {}) {
  try {
    if (!secret() || typeof token !== 'string' || !token || token.length > 512) return null;
    const raw = Buffer.from(token, 'base64url').toString('utf8');
    const parts = raw.split('.');
    if (parts.length !== 3) return null;
    const [id, expStr, given] = parts;
    if (!/^[a-f0-9]{24}$/i.test(id) || !/^\d{1,16}$/.test(expStr) || !/^[a-f0-9]{64}$/.test(given)) return null;
    const expected = mac(`${id}.${expStr}`);
    const a = Buffer.from(given, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const exp = Number(expStr);
    if (!(exp > now)) return null;
    return { noteId: id, expiresAt: new Date(exp) };
  } catch (_) {
    return null;
  }
}

/** The public URL for a token, or null when the API has no public origin configured. */
function shareUrl(token) {
  const base = require('./prescriptionTemplates').publicApiOrigin();
  return base ? `${base}/api/prescriptions/shared/${token}.pdf` : null;
}

module.exports = {
  renderPrescriptionPdf,
  prescriptionFilename,
  makeShareToken,
  verifyShareToken,
  shareUrl,
  SHARE_TTL_MS,
};
