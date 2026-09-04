/**
 * The daily clinic summary email.
 *
 * One message a day, from the backend, to whoever the clinic nominates —
 * scheduled here rather than on somebody's device so it still arrives when
 * that person is on leave, their laptop is shut, or they have left.
 *
 * Recipients come from DAILY_SUMMARY_RECIPIENTS (comma-separated) so adding or
 * removing someone is a config change rather than a deploy. If it is unset,
 * nothing is sent and a line is logged — silence is better than mailing a
 * hard-coded address that may no longer be right.
 *
 * Everything is counted for ONE clinic day in Asia/Kolkata. Using the server's
 * own midnight would put the late-evening appointments of one day into the
 * next day's report.
 */
const Booking = require('../models/Booking');
const User = require('../models/User');
const Inventory = require('../models/Inventory');
const PreConsultForm = require('../models/PreConsultForm');
const Branch = require('../models/Branch');
const logger = require('../utils/logger');
const { clinicDateKey, clinicDateTime } = require('../utils/bookingTime');

const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function recipients() {
  return String(process.env.DAILY_SUMMARY_RECIPIENTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /.+@.+\..+/.test(s));
}

/** The clinic-local day window for a YYYY-MM-DD key. */
function dayWindow(key) {
  return { from: clinicDateTime(key, '00:00'), to: clinicDateTime(key, '23:59') };
}

/**
 * Gather the numbers for one clinic day.
 * Exported so the panel can preview exactly what the email will say.
 */
async function buildSummary(dateKey = clinicDateKey(new Date())) {
  const { from, to } = dayWindow(dateKey);
  const window = { eventAt: { $gte: from, $lte: to } };

  const [bookings, branches, newPatients, lowStock] = await Promise.all([
    Booking.find(window)
      .select('status consultationStage specialistName preferredLocation fullName followUp source eventAt confirmedTime slotTime')
      .sort({ eventAt: 1 })
      .lean(),
    Branch.find({ isActive: true }).select('name').lean(),
    User.countDocuments({ createdAt: { $gte: from, $lte: to } }),
    Inventory.find({ $expr: { $lte: ['$qohAllBatches', '$reOrderLevel'] } })
      .select('inventoryName qohAllBatches reOrderLevel')
      .limit(15)
      .lean(),
  ]);

  const by = (fn) => bookings.filter(fn).length;
  const counts = {
    total: bookings.length,
    confirmed: by((b) => b.status === 'Confirmed'),
    pending: by((b) => b.status === 'Awaiting Confirmation'),
    cancelled: by((b) => b.status === 'Cancelled'),
    noShow: by((b) => b.status === 'No Show'),
    completed: by((b) => b.status === 'Completed'),
  };

  const branchSplit = branches.map((b) => ({
    name: b.name,
    count: bookings.filter((x) => x.preferredLocation === b.name).length,
  })).filter((r) => r.count > 0);

  // Dermatologist-wise schedule for the day, in time order.
  const bySpecialist = new Map();
  for (const b of bookings) {
    const key = b.specialistName || 'Unassigned';
    if (!bySpecialist.has(key)) bySpecialist.set(key, []);
    bySpecialist.get(key).push(b);
  }

  const followUps = bookings.filter((b) => b.followUp?.required).length;
  const pendingConsults = bookings.filter(
    (b) => b.status === 'Completed' && b.consultationStage
      && !['consultation_completed', 'prescription_created', 'treatment_recommended', 'follow_up_required', 'no_follow_up'].includes(b.consultationStage),
  ).length;

  // A pending form is an appointment today whose patient has no submitted form.
  const userIds = [...new Set(bookings.map((b) => String(b.userId || '')).filter(Boolean))];
  const submitted = userIds.length
    ? await PreConsultForm.find({ userId: { $in: userIds }, status: { $in: ['Submitted', 'Approved', 'Reviewed'] } })
      .select('userId').lean()
    : [];
  const withForm = new Set(submitted.map((f) => String(f.userId)));
  const pendingForms = userIds.filter((id) => !withForm.has(id)).length;

  return {
    date: dateKey,
    counts,
    branchSplit,
    specialists: [...bySpecialist.entries()].map(([name, rows]) => ({
      name,
      count: rows.length,
      slots: rows.map((r) => r.confirmedTime || r.slotTime).filter(Boolean),
    })),
    newPatients,
    followUps,
    pendingForms,
    pendingConsults,
    lowStock: lowStock.map((i) => ({ name: i.inventoryName, qty: i.qohAllBatches, reorder: i.reOrderLevel })),
  };
}

function renderHtml(s) {
  const row = (label, value) =>
    `<tr><td style="padding:6px 0;color:#4F5853;font-size:13px;">${esc(label)}</td>`
    + `<td style="padding:6px 0;text-align:right;font-weight:700;color:#111714;font-size:13px;">${esc(value)}</td></tr>`;

  const pretty = new Date(`${s.date}T12:00:00+05:30`).toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'short', year: 'numeric',
  });

  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111714;">
    <div style="font-size:12px;letter-spacing:2px;color:#032F22;font-weight:800;">ZENNARA</div>
    <h1 style="font-size:19px;margin:6px 0 2px;">Daily summary</h1>
    <div style="color:#7A827E;font-size:13px;margin-bottom:18px;">${esc(pretty)}</div>

    <table style="width:100%;border-collapse:collapse;border-top:1px solid #E6E9E7;">
      ${row('Total appointments', s.counts.total)}
      ${row('Confirmed', s.counts.confirmed)}
      ${row('Pending confirmation', s.counts.pending)}
      ${row('Completed', s.counts.completed)}
      ${row('Cancelled', s.counts.cancelled)}
      ${row('No show', s.counts.noShow)}
    </table>

    ${s.branchSplit.length ? `<h2 style="font-size:14px;margin:20px 0 6px;">By centre</h2>
    <table style="width:100%;border-collapse:collapse;border-top:1px solid #E6E9E7;">
      ${s.branchSplit.map((b) => row(b.name, b.count)).join('')}
    </table>` : ''}

    ${s.specialists.length ? `<h2 style="font-size:14px;margin:20px 0 6px;">Dermatologists</h2>
    <table style="width:100%;border-collapse:collapse;border-top:1px solid #E6E9E7;">
      ${s.specialists.map((d) => row(d.name, `${d.count}${d.slots.length ? ` · ${d.slots.slice(0, 6).join(', ')}` : ''}`)).join('')}
    </table>` : ''}

    <h2 style="font-size:14px;margin:20px 0 6px;">Patients &amp; follow-up</h2>
    <table style="width:100%;border-collapse:collapse;border-top:1px solid #E6E9E7;">
      ${row('New patients', s.newPatients)}
      ${row('Follow-ups flagged', s.followUps)}
      ${row('Pre-consultation forms outstanding', s.pendingForms)}
      ${row('Consultations not closed off', s.pendingConsults)}
    </table>

    ${s.lowStock.length ? `<h2 style="font-size:14px;margin:20px 0 6px;">Stock needing attention</h2>
    <table style="width:100%;border-collapse:collapse;border-top:1px solid #E6E9E7;">
      ${s.lowStock.map((i) => row(i.name, `${i.qty} left (reorder at ${i.reorder})`)).join('')}
    </table>` : ''}

    <p style="color:#7A827E;font-size:11.5px;line-height:17px;margin-top:22px;">
      Sent automatically by Zennara. Counts cover ${esc(pretty)} in clinic time (Asia/Kolkata).
    </p>
  </div>`;
}

/**
 * Build and send the summary. Never throws — a mail failure must not take the
 * scheduler down or stop the next evening's send.
 */
async function sendDailySummary({ dateKey = clinicDateKey(new Date()), trigger = 'schedule' } = {}) {
  const to = recipients();
  if (!to.length) {
    logger.info('Daily summary not sent — DAILY_SUMMARY_RECIPIENTS is empty');
    return { sent: 0, skipped: true };
  }

  try {
    const summary = await buildSummary(dateKey);
    const html = renderHtml(summary);
    const { sendRawEmail } = require('../utils/emailService');
    let sent = 0;
    for (const address of to) {
      // One message each rather than a shared To:, so a bad address cannot
      // take the whole send down and nobody sees the others' addresses.
      const ok = await sendRawEmail(address, `Zennara daily summary — ${summary.date}`, html)
        .then(() => true)
        .catch((e) => { logger.warn('Daily summary send failed', { address, error: e.message }); return false; });
      if (ok) sent += 1;
    }
    logger.info('Daily summary sent', { sent, of: to.length, date: summary.date, trigger });
    return { sent, of: to.length, date: summary.date };
  } catch (error) {
    logger.error('Daily summary failed', { error: error.message });
    return { sent: 0, error: error.message };
  }
}

module.exports = { buildSummary, renderHtml, sendDailySummary };
