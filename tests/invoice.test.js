const test = require('node:test');
const assert = require('node:assert/strict');
const Invoice = require('../models/Invoice');
const { amountInWords } = require('../utils/amountInWords');
const { defaultPrefix } = require('../utils/invoiceNumbers');

const oid = () => new (require('mongoose').Types.ObjectId)();

test('service line at a tax-inclusive price splits GST the way Zenoti prints it', () => {
  const inv = new Invoice({ invoiceNumber: 'T1', branchId: oid(), lines: [{ kind: 'service', name: 'Acne facial', qty: 1, unitPrice: 6500, priceIncludesTax: true, taxPercent: 5 }] });
  inv.recalc();
  assert.equal(inv.lines[0].base, 6190.48);
  assert.equal(inv.lines[0].tax, 309.52);
  assert.equal(inv.totals.total, 6500);
  assert.equal(inv.totals.cgst, 154.76);
  assert.equal(inv.totals.sgst, 154.76);
  assert.equal(inv.totals.due, 6500);
});

test('tax-exclusive pharmacy lines add GST and round the bill to the rupee', () => {
  const inv = new Invoice({ invoiceNumber: 'T2', branchId: oid(), lines: [
    { kind: 'product', name: 'Epiduo Gel Forte', qty: 1, unitPrice: 1759.05, priceIncludesTax: false, taxPercent: 5 },
    { kind: 'product', name: 'Foltene shampoo', qty: 1, unitPrice: 1356.19, priceIncludesTax: false, taxPercent: 5 },
  ] });
  inv.recalc();
  assert.equal(inv.totals.net, 3115.24);
  assert.equal(inv.totals.tax, 155.76);
  assert.equal(inv.totals.total, 3271);
  assert.equal(Math.abs(inv.totals.rounding) < 0.01, true);
  assert.equal(inv.taxSummary.length, 1);
  assert.equal(inv.taxSummary[0].rate, 5);
});

test('a redeemed line bills zero but keeps its list value; invoice discount spreads over billable lines only', () => {
  const inv = new Invoice({ invoiceNumber: 'T3', branchId: oid(), invoiceDiscount: { percent: 10 }, lines: [
    { kind: 'service', name: 'Acne facial', qty: 1, unitPrice: 6500, priceIncludesTax: true, taxPercent: 5 },
    { kind: 'service', name: 'Exosome 5ml', qty: 1, unitPrice: 20000, priceIncludesTax: true, taxPercent: 5, redeemed: { kind: 'package', label: 'Exosome 3 session — redeemed' } },
  ] });
  inv.recalc();
  assert.equal(inv.lines[1].total, 0);
  assert.equal(inv.totals.redeemed, 19047.62);
  assert.equal(inv.lines[0].invoiceDiscountShare, 619.05);
  assert.equal(inv.lines[0].net, 5571.43);
  assert.equal(inv.totals.total, 5850);
});

test('split tender: cash + custom UPI settles the bill and reports change on cash overpayment', () => {
  const inv = new Invoice({ invoiceNumber: 'T4', branchId: oid(), lines: [{ kind: 'product', name: 'Cream', qty: 1, unitPrice: 3271, priceIncludesTax: true, taxPercent: 5 }],
    payments: [{ method: 'Cash', amount: 3200 }, { method: 'Custom', customName: 'UPI', amount: 71 }] });
  inv.recalc();
  assert.equal(inv.totals.paid, 3271);
  assert.equal(inv.totals.due, 0);
  inv.payments.push({ method: 'Cash', amount: 29 });
  inv.recalc();
  assert.equal(inv.totals.change, 29);
  inv.payments[2].voided = true;
  inv.recalc();
  assert.equal(inv.totals.change, 0);
});

test('inter-state bills carry IGST instead of the CGST/SGST split', () => {
  const inv = new Invoice({ invoiceNumber: 'T5', branchId: oid(), interState: true, lines: [{ kind: 'service', name: 'Peel', qty: 2, unitPrice: 1050, priceIncludesTax: true, taxPercent: 5 }] });
  inv.recalc();
  assert.equal(inv.totals.igst, 100);
  assert.equal(inv.totals.cgst, 0);
  assert.equal(inv.totals.total, 2100);
});

test('amount in words reads like the Zenoti receipt', () => {
  assert.equal(amountInWords(3271), 'Three Thousand Two Hundred Seventy One Rupees Only');
  assert.equal(amountInWords(72877.12), 'Seventy Two Thousand Eight Hundred Seventy Seven Rupees and Twelve Paise Only');
  assert.equal(amountInWords(0), 'Zero Rupees Only');
  assert.equal(amountInWords(12500000), 'One Crore Twenty Five Lakh Rupees Only');
});

test('centres without a configured prefix get ZN + initials', () => {
  assert.equal(defaultPrefix({ name: 'Jubilee Hills' }), 'ZNJH');
  assert.equal(defaultPrefix({ name: 'Kondapur' }), 'ZNK');
  assert.equal(defaultPrefix({ name: 'Financial District Pharmacy' }), 'ZNFD');
});
