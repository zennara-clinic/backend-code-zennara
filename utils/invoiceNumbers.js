/**
 * Invoice and receipt numbering, per centre per year, the way Zenoti does it
 * ("ZNJH2639667" at the clinic, "ZJHP2616" / receipt "ZJHP26R10" at the
 * pharmacy). A centre's prefix comes from Branch.invoicePrefix; when the desk
 * has not set one we derive "ZN" + the initials of the centre name so the
 * numbers are still recognisable ("Jubilee Hills" → ZNJH).
 */
const Counter = require('../models/Counter');

function defaultPrefix(branch) {
  const words = String(branch?.name || '').replace(/[^A-Za-z ]/g, ' ').split(/\s+/).filter(Boolean);
  const initials = words.slice(0, 2).map((w) => w[0].toUpperCase()).join('') || 'HQ';
  return `ZN${initials}`;
}

const prefixFor = (branch) => String(branch?.invoicePrefix || defaultPrefix(branch)).toUpperCase();
const yearKey = (d = new Date()) => String(d.getFullYear()).slice(-2);

async function issueInvoiceNumber(branch, at = new Date()) {
  const prefix = prefixFor(branch);
  const yy = yearKey(at);
  const seq = await Counter.next(`invoice:${branch._id}:${yy}`);
  return `${prefix}${yy}${String(seq).padStart(4, '0')}`;
}

async function issueReceiptNumber(branch, at = new Date()) {
  const prefix = prefixFor(branch);
  const yy = yearKey(at);
  const seq = await Counter.next(`receipt:${branch._id}:${yy}`);
  return `${prefix}${yy}R${seq}`;
}

module.exports = { issueInvoiceNumber, issueReceiptNumber, prefixFor, defaultPrefix };
