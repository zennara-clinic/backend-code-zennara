/**
 * The GST receipt for a desk bill, as self-contained HTML (80 mm thermal
 * layout, also fine on A4 and in an email). Mirrors what Zenoti prints for
 * Zennara: TAX INVOICE header with the legal entity, centre, GSTIN / state
 * code / PAN; the guest block with patient id and sex; per-line batch,
 * expiry, HSN and GST; the CGST/SGST split; payments; amount in words;
 * printed-by / closed-by; the clinic's terms.
 */
const { amountInWords } = require('./amountInWords');
const { guestCodeOf } = require('./guestCode');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (n) => `₹${(Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dmy = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' }) : '—');
const dmyhm = (d) => (d ? new Date(d).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }).replace(',', '') : '—');

function renderReceiptHtml(inv, { printedBy = null, printedAt = new Date(), terms = null } = {}) {
  const s = inv.seller || {};
  const g = inv.guest || {};
  const t = inv.totals || {};
  const lines = (inv.lines || []).map((l) => {
    const meta = [];
    if (l.batchNo) meta.push(`B.No: ${esc(l.batchNo)}`);
    if (l.expiryDate) meta.push(`Exp: ${dmy(l.expiryDate)}`);
    meta.push(`Qty: ${l.qty}`);
    const tax = [];
    if (l.hsn) tax.push(`${l.kind === 'service' ? 'SAC' : 'HSN'}: ${esc(l.hsn)}`);
    if (Number(l.taxPercent) > 0) tax.push(`GST ${l.taxPercent}% ${inr(l.tax)}`);
    const redeemed = l.redeemed?.kind ? `<div class="mut">${esc(l.redeemed.label || (l.redeemed.kind === 'package' ? 'Package credit used' : 'Membership credit used'))}</div>` : '';
    const disc = (Number(l.discount) || 0) + (Number(l.invoiceDiscountShare) || 0);
    return `
      <tr><td class="it">${esc(l.name)}${l.soldByName ? `<div class="mut">by ${esc(l.soldByName)}</div>` : ''}${redeemed}<div class="mut">${meta.join(' &nbsp;')}</div>${tax.length ? `<div class="mut">${tax.join(' &nbsp;')}</div>` : ''}${disc > 0 ? `<div class="mut">Discount ${inr(disc)}</div>` : ''}</td>
      <td class="r">${l.qty}</td><td class="r">${l.redeemed?.kind ? '0.00' : inr(l.total)}</td></tr>`;
  }).join('');
  const pays = (inv.payments || []).filter((p) => !p.voided).map((p) => `
      <tr><td>${esc(p.method === 'Custom' ? `Custom (${p.customName || 'Other'})` : p.method.toUpperCase())}${p.reference ? ` <span class="mut">${esc(p.reference)}</span>` : ''}</td><td class="r">${dmyhm(p.paidAt)}</td><td class="r">${inr(p.amount)}</td></tr>`).join('');
  const taxRows = (inv.taxSummary || []).filter((r) => r.rate > 0).map((r) => inv.interState
    ? `<tr><td>IGST ${r.rate}%</td><td class="r">${inr(r.tax)}</td></tr>`
    : `<tr><td>CGST ${r.rate / 2}%</td><td class="r">${inr(r.tax / 2)}</td></tr><tr><td>SGST ${r.rate / 2}%</td><td class="r">${inr(r.tax / 2)}</td></tr>`).join('');
  const status = inv.status === 'void' ? 'VOID' : t.due > 0 ? `DUE ${inr(t.due)}` : 'PAID IN FULL';
  const tc = terms || 'Zennara Clinics – Invoice Terms & Conditions. Services once rendered and medicines once dispensed are non-refundable. Packages are governed by their agreement. Payment due within 30 days.';
  return `<!-- receipt ${esc(inv.invoiceNumber)} -->
<div class="rcpt" style="font-family:'Courier New',ui-monospace,monospace;font-size:12px;line-height:1.35;color:#000;width:100%;max-width:340px;margin:0 auto;background:#fff">
<style>
  .rcpt table{width:100%;border-collapse:collapse}
  .rcpt td,.rcpt th{padding:2px 0;vertical-align:top}
  .rcpt .r{text-align:right;white-space:nowrap}
  .rcpt .c{text-align:center}
  .rcpt .b{font-weight:700}
  .rcpt .mut{color:#444;font-size:10.5px}
  .rcpt hr{border:0;border-top:1px dashed #000;margin:6px 0}
  .rcpt .it{padding-right:6px}
  .rcpt .ttl{font-size:14px;letter-spacing:1px}
  .rcpt .stamp{border:2px solid #000;display:inline-block;padding:2px 8px;font-weight:700;margin:4px 0}
  @media print{ body{margin:0} .rcpt{max-width:none} }
</style>
  <div class="c b ttl">TAX INVOICE</div>
  <div class="c b">${esc(s.legalName || 'Zennara Clinics')}</div>
  <div class="c">${esc(s.name || '')}</div>
  ${s.address ? `<div class="c mut">${esc(s.address)}</div>` : ''}
  <div class="c mut">${s.phone ? `Phone: ${esc(s.phone)}` : ''}${s.phone && s.email ? ' · ' : ''}${s.email ? `Email: ${esc(s.email)}` : ''}</div>
  <hr/>
  <table>
    <tr><td>Invoice No</td><td class="r b">${esc(inv.invoiceNumber)}</td></tr>
    <tr><td>Receipt No</td><td class="r">${esc(inv.receiptNumber || '—')}</td></tr>
    <tr><td>Date</td><td class="r">${dmyhm(inv.closedAt || inv.issuedAt)}</td></tr>
    ${s.gstin ? `<tr><td>GST No</td><td class="r">${esc(s.gstin)}${s.stateCode ? ` &nbsp;State Code: ${esc(s.stateCode)}` : ''}</td></tr>` : ''}
    ${s.pan ? `<tr><td>PAN</td><td class="r">${esc(s.pan)}</td></tr>` : ''}
  </table>
  <hr/>
  <div class="b">${esc(g.name || 'Guest')}</div>
  <div class="mut">${g.phone ? esc(g.phone) : ''}${g.gender ? ` · Sex: ${esc(g.gender)}` : ''}${guestCodeOf(g) ? ` · Guest code ${esc(guestCodeOf(g))}` : ''}${g.stateCode ? ` · State ${esc(g.stateCode)}` : ''}</div>
  ${g.gstin ? `<div class="mut">GSTIN ${esc(g.gstin)}</div>` : ''}
  <hr/>
  <table>
    <tr><th style="text-align:left">ITEM</th><th class="r">QTY</th><th class="r">PRICE</th></tr>
    ${lines || '<tr><td colspan="3" class="c mut">No items</td></tr>'}
  </table>
  <hr/>
  <table>
    <tr><td>Sub Total</td><td class="r">${inr(t.net)}</td></tr>
    ${(t.lineDiscount + t.invoiceDiscount) > 0 ? `<tr><td>Discount</td><td class="r">-${inr(t.lineDiscount + t.invoiceDiscount)}</td></tr>` : ''}
    ${taxRows}
    <tr><td>Total Tax</td><td class="r">${inr(t.tax)}</td></tr>
    ${Number(t.rounding) ? `<tr><td>Rounding</td><td class="r">${inr(t.rounding)}</td></tr>` : ''}
    <tr class="b"><td>Total</td><td class="r">${inr(t.total)}</td></tr>
  </table>
  <hr/>
  <div class="b">PAYMENTS</div>
  <table>${pays || '<tr><td class="mut">No payment taken yet</td></tr>'}</table>
  <table>
    <tr class="b"><td>Total Paid</td><td class="r">${inr(t.paid)}</td></tr>
    ${t.change > 0 ? `<tr><td>Change</td><td class="r">${inr(t.change)}</td></tr>` : ''}
    ${t.due > 0 ? `<tr><td>Balance Due</td><td class="r">${inr(t.due)}</td></tr>` : ''}
  </table>
  <div class="mut">${esc(amountInWords(t.total))}</div>
  <div class="c"><span class="stamp">${status}</span></div>
  ${Number(t.rounding) ? `<div class="mut">This invoice includes a rounding adjustment of ${inr(t.rounding)}.</div>` : ''}
  <hr/>
  <div class="mut">Printed By: ${esc(printedBy || '—')} &nbsp; Printed On: ${dmyhm(printedAt)}</div>
  ${inv.closedByName ? `<div class="mut">Closed By: ${esc(inv.closedByName)}</div>` : ''}
  ${inv.comments ? `<div class="mut">Note: ${esc(inv.comments)}</div>` : ''}
  <hr/>
  <div class="mut">${esc(tc)}</div>
</div>`;
}

function receiptText(inv) {
  const t = inv.totals || {};
  const items = (inv.lines || []).map((l) => `• ${l.name} ×${l.qty} — ${l.redeemed?.kind ? '₹0 (credit)' : `₹${(l.total || 0).toLocaleString('en-IN')}`}`).join('\n');
  const pays = (inv.payments || []).filter((p) => !p.voided).map((p) => `${p.method === 'Custom' ? p.customName || 'Other' : p.method} ₹${(p.amount || 0).toLocaleString('en-IN')}`).join(', ');
  return `Zennara — Tax invoice ${inv.invoiceNumber}${inv.receiptNumber ? ` (receipt ${inv.receiptNumber})` : ''}\n${inv.seller?.name || ''}\n\n${items}\n\nTotal ₹${(t.total || 0).toLocaleString('en-IN')} (incl. GST ₹${(t.tax || 0).toLocaleString('en-IN')})\nPaid: ${pays || '—'}${t.due > 0 ? `\nBalance due ₹${t.due.toLocaleString('en-IN')}` : ''}\n\nThank you for visiting us.`;
}

module.exports = { renderReceiptHtml, receiptText };
