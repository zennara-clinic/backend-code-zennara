const test = require('node:test');
const assert = require('node:assert/strict');
const { valueRow, summarise, unitCost } = require('../utils/stockValuation');
const StockCount = require('../models/StockCount');
const StockTransfer = require('../models/StockTransfer');
const mongoose = require('mongoose');

const oid = () => new mongoose.Types.ObjectId();

test('valuation bases: average cost, configured selling price, last procured price', () => {
  const row = { qohAllBatches: 5, avgCost: 787.64, inventoryBuyingPrice: 700, inventorySellingPrice: 1450, lastProcuredPrice: 800, gstPercentage: 5 };
  assert.equal(unitCost(row, 'avg'), 787.64);
  assert.equal(unitCost(row, 'configured'), 1450);
  assert.equal(unitCost(row, 'lastProcured'), 800);
  assert.deepEqual(valueRow(row, 'avg'), { unit: 787.64, qty: 5, cost: 3938.2, tax: 196.91 });
  assert.equal(valueRow({ qohAllBatches: 3, inventoryBuyingPrice: 100 }, 'avg').cost, 300);
});

test('summarise totals on-hand, cost, tax and per-category split', () => {
  const rows = [
    { inventoryCategory: 'Retail products', qohAllBatches: 10, avgCost: 100, inventorySellingPrice: 150, gstPercentage: 18 },
    { inventoryCategory: 'Consumables', qohAllBatches: 0, avgCost: 50, inventorySellingPrice: 60, gstPercentage: 5 },
    { inventoryCategory: 'Consumables', qohAllBatches: 4, avgCost: 25, inventorySellingPrice: 30, gstPercentage: 5 },
  ];
  const s = summarise(rows);
  assert.equal(s.items, 3); assert.equal(s.inStock, 2); assert.equal(s.onHand, 14);
  assert.equal(s.cost, 1100); assert.equal(s.tax, 185); assert.equal(s.configured, 1620);
  assert.deepEqual(s.byCategory['Consumables'], { items: 2, onHand: 4, cost: 100 });
});

test('count sheet totals: variance qty/value, short vs excess, uncounted lines ignored', () => {
  const doc = new StockCount({ ref: 'AUD26-001', lines: [
    { inventoryId: oid(), name: 'A', expected: 10, counted: 8, unitCost: 100 },
    { inventoryId: oid(), name: 'B', expected: 5, counted: 7, unitCost: 50 },
    { inventoryId: oid(), name: 'C', expected: 3, counted: null, unitCost: 10 },
  ] });
  const t = doc.recalc();
  assert.equal(t.items, 3); assert.equal(t.counted, 2);
  assert.equal(t.varianceQty, 0); assert.equal(t.varianceValue, -100);
  assert.equal(t.shortQty, 2); assert.equal(t.excessQty, 2);
  assert.equal(t.stockValueBefore, 1280);
});

test('transfer totals value the lines at their unit cost', () => {
  const doc = new StockTransfer({ ref: 'TR26-0001', fromBranchId: oid(), toBranchId: oid(), lines: [{ inventoryId: oid(), qty: 15, unitCost: 120 }, { inventoryId: oid(), qty: 1, unitCost: 5405.08 }] });
  const t = doc.recalc();
  assert.equal(t.qty, 16); assert.equal(t.value, 7205.08);
});
