/**
 * Stock control — Zenoti's Inventory module beyond the item list:
 * Current stock (per centre, valued three ways), Audits (count sheets →
 * reconcile), Transfers between centres, and the valuation dashboard.
 * Every quantity change goes through the StockMovement ledger.
 */
const mongoose = require('mongoose');
const Inventory = require('../models/Inventory');
const StockMovement = require('../models/StockMovement');
const StockCount = require('../models/StockCount');
const StockTransfer = require('../models/StockTransfer');
const Branch = require('../models/Branch');
const Counter = require('../models/Counter');
const { valueRow, summarise, unitCost, r2 } = require('../utils/stockValuation');

const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ''));
const fail = (res, status, message, extra = {}) => res.status(status).json({ success: false, message, ...extra });
const who = (req) => ({ id: req.admin?._id || null, name: req.admin?.name || req.admin?.email || 'Admin', email: req.admin?.email || '' });
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const yy = () => String(new Date().getFullYear()).slice(-2);

/** Rows at a centre. `branchId=none` = rows never tagged with a centre (legacy). */
function branchFilter(branchId) {
  if (!branchId || branchId === 'all') return {};
  if (branchId === 'none') return { branchId: null };
  return isId(branchId) ? { branchId } : {};
}

async function stockQuery(q) {
  const f = { ...branchFilter(q.branchId) };
  if (q.category && q.category !== 'All') f.inventoryCategory = q.category;
  if (isId(q.vendorId)) f.vendorId = q.vendorId;
  if (q.search) { const rx = new RegExp(esc(String(q.search).trim()), 'i'); f.$or = [{ inventoryName: rx }, { code: rx }, { batchNo: rx }, { vendorName: rx }]; }
  if (q.inStock === 'true') f.qohAllBatches = { $gt: 0 };
  return f;
}

/* ------------------------------------------------------------------------ */
/* Current stock + valuation                                                 */
/* ------------------------------------------------------------------------ */

// GET /api/admin/stock/current?branchId&category&vendorId&search&inStock&basis
exports.currentStock = async (req, res) => {
  try {
    const basis = ['avg', 'configured', 'lastProcured'].includes(req.query.basis) ? req.query.basis : 'avg';
    const rows = await Inventory.find(await stockQuery(req.query)).populate('vendorId', 'name').populate('branchId', 'name').sort({ inventoryName: 1 }).lean();
    const last = await StockCount.findOne({ status: 'reconciled', ...(isId(req.query.branchId) ? { branchId: req.query.branchId } : {}) }).sort({ reconciledAt: -1 }).select('reconciledAt ref').lean();
    const data = rows.map((r) => {
      const avg = valueRow(r, 'avg'); const cfg = valueRow(r, 'configured'); const lp = valueRow(r, 'lastProcured');
      return {
        _id: r._id, code: r.code || null, name: r.inventoryName, category: r.inventoryCategory, unit: r.packName || r.formulation || null, batchNo: r.batchNo || null, expiryDate: r.batchExpiryDate || null,
        vendor: r.vendorId?.name || r.vendorName || null, branch: r.branchId?.name || null, branchId: r.branchId?._id || null,
        onHand: avg.qty, reOrderLevel: r.reOrderLevel || 0, gstPercent: r.gstPercentage || 0,
        avg: { unit: avg.unit, cost: avg.cost, tax: avg.tax }, configured: { unit: cfg.unit, cost: cfg.cost }, lastProcured: { unit: lp.unit, cost: lp.cost, at: r.lastProcuredAt || null },
        lastCountedAt: r.lastCountedAt || null, lastReconciledAt: r.lastReconciledAt || null,
      };
    });
    return res.json({ success: true, data, totals: summarise(rows, basis), basis, lastReconcile: last ? { at: last.reconciledAt, ref: last.ref } : null });
  } catch (e) { console.error('currentStock error:', e); return fail(res, 500, 'Could not load current stock'); }
};

// GET /api/admin/stock/valuation?branchId — totals per centre + per category + audit history
exports.valuation = async (req, res) => {
  try {
    const rows = await Inventory.find(branchFilter(req.query.branchId)).select('branchId inventoryCategory qohAllBatches avgCost inventoryBuyingPrice batchBuyingPrice inventorySellingPrice batchSellingPrice lastProcuredPrice gstPercentage').lean();
    const branches = await Branch.find({}).select('name').lean();
    const nameOf = new Map(branches.map((b) => [String(b._id), b.name]));
    const byBranch = {};
    for (const r of rows) { const k = r.branchId ? String(r.branchId) : 'none'; (byBranch[k] = byBranch[k] || []).push(r); }
    const perBranch = Object.entries(byBranch).map(([k, list]) => ({ branchId: k === 'none' ? null : k, branch: k === 'none' ? 'Not assigned to a centre' : nameOf.get(k) || 'Centre', ...summarise(list) }));
    const history = await StockCount.find({ status: 'reconciled', ...(isId(req.query.branchId) ? { branchId: req.query.branchId } : {}) }).sort({ reconciledAt: 1 }).limit(24).select('ref branchName reconciledAt totals').lean();
    return res.json({ success: true, data: { total: summarise(rows), perBranch, history: history.map((h) => ({ ref: h.ref, branch: h.branchName, at: h.reconciledAt, before: h.totals?.stockValueBefore || 0, after: h.totals?.stockValueAfter ?? null, varianceValue: h.totals?.varianceValue || 0 })) } });
  } catch (e) { console.error('valuation error:', e); return fail(res, 500, 'Could not value the stock'); }
};

/* ------------------------------------------------------------------------ */
/* Audits (count sheets)                                                     */
/* ------------------------------------------------------------------------ */

exports.listCounts = async (req, res) => {
  const f = {};
  if (isId(req.query.branchId)) f.branchId = req.query.branchId;
  if (req.query.status && req.query.status !== 'all') f.status = req.query.status;
  const rows = await StockCount.find(f).sort({ createdAt: -1 }).limit(100).select('-lines').lean();
  return res.json({ success: true, data: rows });
};

exports.getCount = async (req, res) => {
  const doc = await StockCount.findById(req.params.id).lean();
  if (!doc) return fail(res, 404, 'Audit not found');
  return res.json({ success: true, data: doc });
};

// POST /api/admin/stock/counts { branchId, category?, vendorId?, search?, title? }
exports.createCount = async (req, res) => {
  try {
    const { branchId, category, vendorId, search, title } = req.body || {};
    const branch = isId(branchId) ? await Branch.findById(branchId).select('name').lean() : null;
    const rows = await Inventory.find(await stockQuery({ branchId: branchId || 'all', category, vendorId, search })).sort({ inventoryName: 1 }).lean();
    if (!rows.length) return fail(res, 400, 'No stock rows match — nothing to count.');
    const seq = await Counter.next(`stockcount:${yy()}`);
    const me = who(req);
    const doc = new StockCount({
      ref: `AUD${yy()}-${String(seq).padStart(3, '0')}`, branchId: branch?._id || null, branchName: branch?.name || (branchId === 'none' ? 'Not assigned' : 'All centres'),
      title: title || `${category && category !== 'All' ? category : 'Stock'} audit · ${branch?.name || 'all centres'}`,
      scope: { category: category && category !== 'All' ? category : null, vendorId: isId(vendorId) ? vendorId : null, search: search || null },
      lines: rows.map((r) => ({ inventoryId: r._id, name: r.inventoryName, code: r.code || null, batchNo: r.batchNo || null, category: r.inventoryCategory, unit: r.packName || r.formulation || null, expected: Number(r.qohAllBatches) || 0, counted: null, unitCost: unitCost(r, 'avg') })),
      createdById: me.id, createdByName: me.name,
    });
    doc.recalc();
    await doc.save();
    return res.status(201).json({ success: true, data: doc, message: `Count sheet ${doc.ref} opened with ${rows.length} lines` });
  } catch (e) { console.error('createCount error:', e); return fail(res, 500, e.message || 'Could not open the count sheet'); }
};

// PUT /api/admin/stock/counts/:id { lines: [{ lineId | inventoryId, counted, note }], notes? }
exports.updateCount = async (req, res) => {
  try {
    const doc = await StockCount.findById(req.params.id);
    if (!doc) return fail(res, 404, 'Audit not found');
    if (doc.status !== 'open') return fail(res, 409, `This audit is ${doc.status}; counts can no longer be changed.`);
    const me = who(req);
    let touched = 0;
    for (const e of Array.isArray(req.body?.lines) ? req.body.lines : []) {
      const line = (e.lineId && doc.lines.id(e.lineId)) || doc.lines.find((l) => String(l.inventoryId) === String(e.inventoryId));
      if (!line) continue;
      if (e.counted === null || e.counted === '' || e.counted === undefined) { line.counted = null; line.countedAt = null; line.countedByName = null; }
      else { line.counted = Math.max(0, Number(e.counted) || 0); line.countedAt = new Date(); line.countedByName = me.name; }
      if (e.note !== undefined) line.note = String(e.note || '');
      touched += 1;
    }
    if (req.body?.notes !== undefined) doc.notes = String(req.body.notes || '');
    if (req.body?.title !== undefined) doc.title = String(req.body.title || '');
    doc.recalc();
    await doc.save();
    return res.json({ success: true, data: doc, touched });
  } catch (e) { return fail(res, 500, e.message || 'Could not save the counts'); }
};

exports.submitCount = async (req, res) => {
  try {
    const doc = await StockCount.findById(req.params.id);
    if (!doc) return fail(res, 404, 'Audit not found');
    if (doc.status !== 'open') return fail(res, 409, `This audit is already ${doc.status}.`);
    const missing = doc.lines.filter((l) => l.counted === null || l.counted === undefined).length;
    if (missing && !req.body?.allowMissing) return fail(res, 409, `${missing} line${missing === 1 ? '' : 's'} still uncounted. Enter them, or submit treating uncounted lines as unchanged.`, { code: 'UNCOUNTED_LINES', missing });
    doc.status = 'submitted'; doc.submittedAt = new Date(); doc.submittedByName = who(req).name;
    doc.recalc();
    await doc.save();
    await Inventory.updateMany({ _id: { $in: doc.lines.filter((l) => l.counted !== null && l.counted !== undefined).map((l) => l.inventoryId) } }, { $set: { lastCountedAt: new Date() } });
    return res.json({ success: true, data: doc, message: `Audit ${doc.ref} submitted — ${doc.totals.varianceQty >= 0 ? '+' : ''}${doc.totals.varianceQty} units variance` });
  } catch (e) { return fail(res, 500, e.message || 'Could not submit the audit'); }
};

/**
 * POST /api/admin/stock/counts/:id/reconcile — write the counted figures to the
 * shelf. The adjustment is against the shelf as it is NOW (sales since the
 * sheet was opened are not undone), so `applied` may differ from the variance.
 */
exports.reconcileCount = async (req, res) => {
  try {
    const doc = await StockCount.findById(req.params.id);
    if (!doc) return fail(res, 404, 'Audit not found');
    if (!['open', 'submitted'].includes(doc.status)) return fail(res, 409, `This audit is ${doc.status}.`);
    const me = who(req); const now = new Date();
    let adjusted = 0; let valueAfter = 0;
    for (const l of doc.lines) {
      const row = await Inventory.findById(l.inventoryId).select('qohAllBatches qohBatchWise inventoryName batchNo avgCost inventoryBuyingPrice batchBuyingPrice');
      if (!row) continue;
      const shelf = Number(row.qohAllBatches) || 0;
      if (l.counted === null || l.counted === undefined) { l.shelfAtReconcile = shelf; l.applied = 0; valueAfter += shelf * (Number(l.unitCost) || 0); continue; }
      const delta = (Number(l.counted) || 0) - shelf;
      l.shelfAtReconcile = shelf; l.applied = delta;
      if (delta !== 0) {
        await Inventory.updateOne({ _id: row._id }, { $set: { qohAllBatches: shelf + delta, qohBatchWise: Math.max(0, (Number(row.qohBatchWise) || 0) + delta), lastReconciledAt: now, lastCountedAt: now } });
        await StockMovement.create({ inventoryId: row._id, inventoryName: row.inventoryName, batchNo: l.batchNo || row.batchNo || '', type: 'count', delta, before: shelf, after: shelf + delta, reason: `Audit ${doc.ref}${l.note ? `: ${l.note}` : ''}`, branchId: doc.branchId, adminId: me.id, adminEmail: me.email, stockCountId: doc._id, unitCost: l.unitCost || null });
        adjusted += 1;
      } else await Inventory.updateOne({ _id: row._id }, { $set: { lastReconciledAt: now, lastCountedAt: now } });
      valueAfter += (Number(l.counted) || 0) * (Number(l.unitCost) || 0);
    }
    doc.status = 'reconciled'; doc.reconciledAt = now; doc.reconciledById = me.id; doc.reconciledByName = me.name;
    doc.recalc();
    doc.totals.stockValueAfter = r2(valueAfter);
    await doc.save();
    return res.json({ success: true, data: doc, message: `Reconciled — ${adjusted} line${adjusted === 1 ? '' : 's'} adjusted on the shelf` });
  } catch (e) { console.error('reconcile error:', e); return fail(res, 500, e.message || 'Could not reconcile'); }
};

exports.cancelCount = async (req, res) => {
  const doc = await StockCount.findById(req.params.id);
  if (!doc) return fail(res, 404, 'Audit not found');
  if (doc.status === 'reconciled') return fail(res, 409, 'A reconciled audit cannot be cancelled.');
  doc.status = 'cancelled'; doc.cancelledAt = new Date(); doc.cancelReason = String(req.body?.reason || '') || null;
  await doc.save();
  return res.json({ success: true, data: doc, message: 'Audit cancelled' });
};

/* ------------------------------------------------------------------------ */
/* Transfers between centres                                                 */
/* ------------------------------------------------------------------------ */

exports.listTransfers = async (req, res) => {
  const f = {};
  if (isId(req.query.branchId)) f.$or = [{ fromBranchId: req.query.branchId }, { toBranchId: req.query.branchId }];
  if (req.query.status && req.query.status !== 'all') f.status = req.query.status;
  const rows = await StockTransfer.find(f).sort({ createdAt: -1 }).limit(100).lean();
  return res.json({ success: true, data: rows });
};

exports.getTransfer = async (req, res) => {
  const doc = await StockTransfer.findById(req.params.id).lean();
  if (!doc) return fail(res, 404, 'Transfer not found');
  return res.json({ success: true, data: doc });
};

// POST /api/admin/stock/transfers { fromBranchId, toBranchId, kind?, lines: [{ inventoryId, qty, note }], notes?, send?: boolean }
exports.createTransfer = async (req, res) => {
  try {
    const { fromBranchId, toBranchId, kind, lines, notes, send } = req.body || {};
    if (!isId(fromBranchId) || !isId(toBranchId)) return fail(res, 400, 'Pick the centre sending and the centre receiving.');
    if (String(fromBranchId) === String(toBranchId)) return fail(res, 400, 'The two centres must differ.');
    const [from, to] = await Promise.all([Branch.findById(fromBranchId).select('name').lean(), Branch.findById(toBranchId).select('name').lean()]);
    if (!from || !to) return fail(res, 404, 'Centre not found');
    const items = [];
    for (const l of Array.isArray(lines) ? lines : []) {
      const qty = Math.floor(Number(l.qty) || 0);
      if (!isId(l.inventoryId) || qty <= 0) continue;
      const row = await Inventory.findById(l.inventoryId).lean();
      if (!row) return fail(res, 404, 'A stock row on the transfer no longer exists');
      if (row.branchId && String(row.branchId) !== String(fromBranchId)) return fail(res, 400, `${row.inventoryName} is not held at ${from.name}.`);
      items.push({ inventoryId: row._id, name: row.inventoryName, code: row.code || null, batchNo: row.batchNo || null, expiryDate: row.batchExpiryDate || null, qty, unitCost: unitCost(row, 'avg'), note: l.note || '' });
    }
    if (!items.length) return fail(res, 400, 'Add at least one item with a quantity.');
    const seq = await Counter.next(`stocktransfer:${yy()}`);
    const me = who(req);
    const doc = new StockTransfer({ ref: `TR${yy()}-${String(seq).padStart(4, '0')}`, kind: kind === 'return' ? 'return' : 'transfer', fromBranchId, fromBranchName: from.name, toBranchId, toBranchName: to.name, lines: items, notes: notes || '', createdById: me.id, createdByName: me.name });
    doc.recalc();
    await doc.save();
    if (send) { const r = await sendTransfer(doc, me); if (!r.ok) return fail(res, 409, r.message, { code: r.code, data: doc }); }
    return res.status(201).json({ success: true, data: doc, message: send ? `Transfer ${doc.ref} sent` : `Transfer ${doc.ref} drafted` });
  } catch (e) { console.error('createTransfer error:', e); return fail(res, 500, e.message || 'Could not create the transfer'); }
};

async function sendTransfer(doc, me) {
  if (doc.status !== 'draft') return { ok: false, code: 'NOT_DRAFT', message: `Transfer is ${doc.status}.` };
  const done = [];
  for (const l of doc.lines) {
    const upd = await Inventory.findOneAndUpdate({ _id: l.inventoryId, qohAllBatches: { $gte: l.qty } }, { $inc: { qohAllBatches: -l.qty, qohBatchWise: -l.qty } }, { new: true });
    if (!upd) {
      // roll back what already left the shelf
      for (const d of done) await Inventory.updateOne({ _id: d.inventoryId }, { $inc: { qohAllBatches: d.qty, qohBatchWise: d.qty } });
      const cur = await Inventory.findById(l.inventoryId).select('qohAllBatches inventoryName').lean();
      return { ok: false, code: 'INSUFFICIENT_STOCK', message: `Not enough ${cur?.inventoryName || l.name} at ${doc.fromBranchName} (have ${cur?.qohAllBatches ?? 0}, sending ${l.qty}).` };
    }
    done.push({ inventoryId: l.inventoryId, qty: l.qty });
    await StockMovement.create({ inventoryId: l.inventoryId, inventoryName: upd.inventoryName, batchNo: l.batchNo || '', type: 'transfer_out', delta: -l.qty, before: upd.qohAllBatches + l.qty, after: upd.qohAllBatches, reason: `Transfer ${doc.ref} → ${doc.toBranchName}`, branchId: doc.fromBranchId, adminId: me.id, adminEmail: me.email, stockTransferId: doc._id, unitCost: l.unitCost || null });
  }
  doc.status = 'sent'; doc.sentAt = new Date(); doc.sentByName = me.name;
  await doc.save();
  return { ok: true };
}

exports.sendTransfer = async (req, res) => {
  const doc = await StockTransfer.findById(req.params.id);
  if (!doc) return fail(res, 404, 'Transfer not found');
  const r = await sendTransfer(doc, who(req));
  if (!r.ok) return fail(res, 409, r.message, { code: r.code });
  return res.json({ success: true, data: doc, message: `Transfer ${doc.ref} sent — ${doc.totals.qty} units left ${doc.fromBranchName}` });
};

// POST /api/admin/stock/transfers/:id/receive { lines?: [{ lineId, receivedQty }] }
exports.receiveTransfer = async (req, res) => {
  try {
    const doc = await StockTransfer.findById(req.params.id);
    if (!doc) return fail(res, 404, 'Transfer not found');
    if (doc.status !== 'sent') return fail(res, 409, `Transfer is ${doc.status}; only a sent transfer can be received.`);
    const me = who(req);
    const overrides = new Map((Array.isArray(req.body?.lines) ? req.body.lines : []).map((l) => [String(l.lineId), Math.max(0, Number(l.receivedQty) || 0)]));
    for (const l of doc.lines) {
      const qty = overrides.has(String(l._id)) ? overrides.get(String(l._id)) : l.qty;
      l.receivedQty = qty;
      if (qty <= 0) continue;
      const src = await Inventory.findById(l.inventoryId).lean();
      // Destination row: same item at the receiving centre (by Zenoti id / code + batch), else a copy of the source row.
      let dest = null;
      if (src) {
        const or = [];
        if (src.zenotiProductId) or.push({ zenotiProductId: src.zenotiProductId });
        if (src.code) or.push({ code: src.code });
        or.push({ inventoryName: src.inventoryName });
        dest = await Inventory.findOne({ branchId: doc.toBranchId, $or: or, ...(src.batchNo ? { batchNo: src.batchNo } : {}) });
        if (!dest) {
          const { _id, createdAt, updatedAt, __v, ...copy } = src;
          dest = await Inventory.create({ ...copy, branchId: doc.toBranchId, qohAllBatches: 0, qohBatchWise: 0, lastCountedAt: null, lastReconciledAt: null });
        }
      }
      if (!dest) continue;
      const before = Number(dest.qohAllBatches) || 0;
      // Receiving at a cost: keep a moving average on the destination too.
      const oldAvg = Number(dest.avgCost) || Number(dest.inventoryBuyingPrice) || l.unitCost || 0;
      const avgCost = before + qty > 0 ? r2((before * oldAvg + qty * (l.unitCost || oldAvg)) / (before + qty)) : l.unitCost || oldAvg;
      await Inventory.updateOne({ _id: dest._id }, { $inc: { qohAllBatches: qty, qohBatchWise: qty }, $set: { avgCost } });
      await StockMovement.create({ inventoryId: dest._id, inventoryName: dest.inventoryName, batchNo: l.batchNo || dest.batchNo || '', type: 'transfer_in', delta: qty, before, after: before + qty, reason: `Transfer ${doc.ref} ← ${doc.fromBranchName}`, branchId: doc.toBranchId, adminId: me.id, adminEmail: me.email, stockTransferId: doc._id, unitCost: l.unitCost || null });
      l.toInventoryId = dest._id;
    }
    doc.status = 'received'; doc.receivedAt = new Date(); doc.receivedByName = me.name;
    await doc.save();
    return res.json({ success: true, data: doc, message: `Transfer ${doc.ref} received at ${doc.toBranchName}` });
  } catch (e) { console.error('receiveTransfer error:', e); return fail(res, 500, e.message || 'Could not receive the transfer'); }
};

exports.cancelTransfer = async (req, res) => {
  try {
    const doc = await StockTransfer.findById(req.params.id);
    if (!doc) return fail(res, 404, 'Transfer not found');
    if (doc.status === 'received') return fail(res, 409, 'A received transfer cannot be cancelled — raise a transfer back instead.');
    if (doc.status === 'cancelled') return fail(res, 409, 'Already cancelled.');
    const me = who(req);
    if (doc.status === 'sent') {
      for (const l of doc.lines) {
        const upd = await Inventory.findByIdAndUpdate(l.inventoryId, { $inc: { qohAllBatches: l.qty, qohBatchWise: l.qty } }, { new: true });
        if (upd) await StockMovement.create({ inventoryId: l.inventoryId, inventoryName: upd.inventoryName, batchNo: l.batchNo || '', type: 'transfer_in', delta: l.qty, before: upd.qohAllBatches - l.qty, after: upd.qohAllBatches, reason: `Transfer ${doc.ref} cancelled — returned to shelf`, branchId: doc.fromBranchId, adminId: me.id, adminEmail: me.email, stockTransferId: doc._id, unitCost: l.unitCost || null });
      }
    }
    doc.status = 'cancelled'; doc.cancelledAt = new Date(); doc.cancelReason = String(req.body?.reason || '') || null;
    await doc.save();
    return res.json({ success: true, data: doc, message: 'Transfer cancelled' });
  } catch (e) { return fail(res, 500, e.message || 'Could not cancel the transfer'); }
};

/* ------------------------------------------------------------------------ */
/* Adjustments (one row, with a reason — Zenoti "Adjustments")               */
/* ------------------------------------------------------------------------ */

// POST /api/admin/stock/adjust { inventoryId, newQty | delta, reason }
exports.adjust = async (req, res) => {
  try {
    const { inventoryId, reason } = req.body || {};
    if (!isId(inventoryId)) return fail(res, 400, 'inventoryId is required');
    if (!String(reason || '').trim()) return fail(res, 400, 'Give a reason for the adjustment');
    const row = await Inventory.findById(inventoryId);
    if (!row) return fail(res, 404, 'Stock row not found');
    const before = Number(row.qohAllBatches) || 0;
    const after = req.body.newQty !== undefined ? Math.max(0, Number(req.body.newQty) || 0) : Math.max(0, before + (Number(req.body.delta) || 0));
    if (after === before) return res.json({ success: true, data: row, message: 'No change' });
    row.qohAllBatches = after; row.qohBatchWise = Math.max(0, (Number(row.qohBatchWise) || 0) + (after - before));
    await row.save({ validateModifiedOnly: true });
    const me = who(req);
    await StockMovement.create({ inventoryId: row._id, inventoryName: row.inventoryName, batchNo: row.batchNo || '', type: after > before ? 'receive' : 'adjust', delta: after - before, before, after, reason: String(reason).trim(), branchId: row.branchId || null, adminId: me.id, adminEmail: me.email, unitCost: unitCost(row, 'avg') || null });
    return res.json({ success: true, data: row, message: `${row.inventoryName}: ${before} → ${after}` });
  } catch (e) { return fail(res, 500, e.message || 'Could not adjust'); }
};

exports._internal = { sendTransfer };
