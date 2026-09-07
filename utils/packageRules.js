/**
 * Package lifecycle rules shared by the desk (assignments console), the bill
 * (redemption at close) and the app (booking a session): building an
 * assignment from a package, freeze / unfreeze, transfer, refund, and the
 * redemption log. Nothing here touches Zenoti.
 */
const PackageAssignment = require('../models/PackageAssignment');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** The assignment document for a package sold to a guest (not saved). */
function buildAssignment(pkg, user, { branchId = null, preferredLocation = '', sessions = [], invoiceId = null, pricePaid = null, listPrice = null, payment = {}, notes = '', assignedBy = null, assignedByName = 'Admin', discountPercentage = 0, isZenMemberDiscount = false, validUntil = null } = {}) {
  const terms = pkg.termsSnapshot ? pkg.termsSnapshot() : { version: 1, validityDays: 365, neverExpires: false, validityStartsAt: 'sale', graceDays: 0, closeWhenConsumed: true, redeemableScope: 'organization', redeemableBranchIds: [], maxFreezes: 0, maxFreezeDays: 0, minPartialPaymentPercent: 0 };
  const now = new Date();
  let until = validUntil ? new Date(validUntil) : null;
  if (!until && !terms.neverExpires && terms.validityStartsAt === 'sale') { until = new Date(now); until.setDate(until.getDate() + (terms.validityDays || 365)); }
  const pa = new PackageAssignment({
    userId: user._id, packageId: pkg._id, invoiceId,
    packageDetails: {
      packageName: pkg.name, packagePrice: pkg.price, originalPrice: pkg.originalPrice,
      services: (pkg.services || []).map((s) => ({ serviceId: s.serviceId, serviceName: s.serviceName, sessions: Math.max(1, Number(s.sessions) || 1), servicePrice: s.customPrice ?? s.servicePrice ?? null, redemptionOrder: Number(s.redemptionOrder) || 1 })),
    },
    userDetails: { fullName: user.fullName || user.name, name: user.fullName || user.name, email: user.email, phone: user.phone, patientId: user.patientId, memberType: user.memberType },
    pricing: { originalAmount: listPrice ?? pkg.price, discountPercentage: discountPercentage || 0, isZenMemberDiscount: !!isZenMemberDiscount },
    payment: { isReceived: !!payment.isReceived, receivedDate: payment.isReceived ? (payment.receivedDate || now) : null, paymentMethod: payment.paymentMethod || null, transactionId: payment.transactionId || null, amountPaid: payment.amountPaid ?? null, balanceDue: payment.balanceDue ?? null },
    notes, terms, validFrom: now, validUntil: until, preferredLocation: preferredLocation || '', branchId: branchId || null,
    sessions: buildSessionRows(pkg, sessions),
    assignedBy, assignedByName,
  });
  if (pricePaid !== null && pricePaid !== undefined) { pa.pricing.originalAmount = listPrice ?? pkg.price; pa.$locals.forceFinal = r2(pricePaid); }
  return pa;
}

/**
 * One session row per entitled session — "Exosome × 3" is three rows, not one.
 *
 * Rows used to be built only from what the panel sent, so a three-session
 * course arrived as a single row while serviceBalances() reported three
 * entitlements: the customer could book once and then had no row left to book
 * against. Any dates the clinic did supply are applied in order; the rest stay
 * undated, which is now the normal case — the customer picks the date in the
 * app whenever they like, up to the package's expiry.
 */
function buildSessionRows(pkg, supplied = []) {
  const byService = new Map();
  (supplied || []).forEach((s) => {
    const id = String(s?.serviceId || '');
    if (!id) return;
    if (!byService.has(id)) byService.set(id, []);
    byService.get(id).push(s);
  });

  const rows = [];
  (pkg.services || []).forEach((ps) => {
    const id = String(ps.serviceId || '');
    if (!id) return;
    const count = Math.max(1, Number(ps.sessions) || 1);
    const given = byService.get(id) || [];
    for (let i = 0; i < count; i += 1) {
      const s = given[i] || {};
      rows.push({
        serviceId: ps.serviceId,
        serviceName: ps.serviceName || s.serviceName || '',
        // Undated is deliberate: a suggested date is a nudge, not a booking.
        scheduledDate: s.scheduledDate ? new Date(s.scheduledDate) : null,
        scheduledTime: s.scheduledTime || '',
        specialistId: s.specialistId || null,
        specialistName: s.specialistName || null,
        specialistTier: s.specialistTier || null,
        status: 'Scheduled',
      });
    }
  });
  return rows;
}

function freeze(pa, { by = 'Admin', reason = '', resumeOn = null } = {}) {
  if (pa.status !== 'Active') throw Object.assign(new Error(`Only an active package can be frozen (this one is ${pa.status.toLowerCase()}).`), { status: 409 });
  if (pa.freeze?.isFrozen) throw Object.assign(new Error('This package is already frozen.'), { status: 409 });
  const max = Number(pa.terms?.maxFreezes) || 0;
  if (max > 0 && (pa.freezeHistory || []).length >= max) throw Object.assign(new Error(`This package allows ${max} freeze${max === 1 ? '' : 's'} and they are used up.`), { status: 409, code: 'FREEZE_LIMIT' });
  pa.freeze = { isFrozen: true, frozenAt: new Date(), frozenBy: by, reason: reason || null, resumeOn: resumeOn ? new Date(resumeOn) : null };
  return pa;
}

/** Unfreeze: the frozen days are added back to the validity (Zenoti extends the expiry by the freeze). */
function unfreeze(pa, { by = 'Admin' } = {}) {
  if (!pa.freeze?.isFrozen) throw Object.assign(new Error('This package is not frozen.'), { status: 409 });
  const from = new Date(pa.freeze.frozenAt || Date.now());
  const now = new Date();
  let days = Math.max(1, Math.round((now - from) / 86400000));
  const maxDays = Number(pa.terms?.maxFreezeDays) || 0;
  if (maxDays > 0) days = Math.min(days, maxDays);
  if (pa.validUntil) { const v = new Date(pa.validUntil); v.setDate(v.getDate() + days); pa.validUntil = v; }
  pa.freezeHistory = [...(pa.freezeHistory || []), { frozenAt: from, resumedAt: now, days, by: pa.freeze.frozenBy, resumedBy: by, reason: pa.freeze.reason }];
  pa.freeze = { isFrozen: false, frozenAt: null, frozenBy: null, reason: null, resumeOn: null };
  return pa;
}

/**
 * Move remaining sessions to another guest: a new assignment for the target
 * with exactly the transferred quantities, and the source's balance reduced
 * (shown in its "Transferred" column). Returns the new assignment (unsaved
 * source + target; caller saves both).
 */
function transfer(pa, target, services, { by = 'Admin', reason = '' } = {}) {
  if (pa.status !== 'Active') throw Object.assign(new Error('Only an active package can be transferred.'), { status: 409 });
  if (pa.freeze?.isFrozen) throw Object.assign(new Error('Unfreeze the package before transferring it.'), { status: 409 });
  if (String(target._id) === String(pa.userId)) throw Object.assign(new Error('Pick a different guest to transfer to.'), { status: 400 });
  const balances = pa.serviceBalances();
  const moves = [];
  for (const want of services || []) {
    const qty = Math.max(0, Math.floor(Number(want.qty) || 0));
    if (!qty) continue;
    const row = balances.find((b) => String(b.serviceId) === String(want.serviceId));
    if (!row) throw Object.assign(new Error(`${want.serviceId} is not on this package.`), { status: 400 });
    if (qty > row.balance) throw Object.assign(new Error(`Only ${row.balance} ${row.serviceName || 'session'}${row.balance === 1 ? '' : 's'} left to transfer.`), { status: 409 });
    moves.push({ serviceId: row.serviceId, serviceName: row.serviceName, qty });
  }
  if (!moves.length) throw Object.assign(new Error('Choose at least one session to transfer.'), { status: 400 });
  const target_pa = new PackageAssignment({
    userId: target._id, packageId: pa.packageId, invoiceId: null,
    packageDetails: { packageName: pa.packageDetails?.packageName, packagePrice: 0, originalPrice: pa.packageDetails?.originalPrice, services: moves.map((m) => ({ serviceId: m.serviceId, serviceName: m.serviceName, sessions: m.qty, servicePrice: (pa.packageDetails?.services || []).find((s) => String(s.serviceId) === String(m.serviceId))?.servicePrice ?? null })) },
    userDetails: { fullName: target.fullName, name: target.fullName, email: target.email, phone: target.phone, patientId: target.patientId, memberType: target.memberType },
    pricing: { originalAmount: 0, discountPercentage: 0 },
    payment: { isReceived: true, receivedDate: new Date(), paymentMethod: 'Other', transactionId: `TRANSFER-${pa.assignmentId}` },
    notes: `Transferred from ${pa.userDetails?.fullName || 'another guest'} (${pa.assignmentId})${reason ? `: ${reason}` : ''}`,
    terms: pa.terms, validFrom: new Date(), validUntil: pa.validUntil, preferredLocation: pa.preferredLocation, branchId: pa.branchId,
    sessions: [], assignedBy: null, assignedByName: by,
    transferredFrom: { assignmentId: pa._id, userId: pa.userId, userName: pa.userDetails?.fullName || null, at: new Date() },
    source: 'panel',
  });
  target_pa.$locals.skipZenotiWrite = true;
  pa.transfers = [...(pa.transfers || []), { at: new Date(), by, toUserId: target._id, toUserName: target.fullName, toAssignmentId: target_pa._id, services: moves, reason: reason || null }];
  // Un-book scheduled-but-unbooked sessions beyond the new balance.
  for (const m of moves) {
    let drop = m.qty;
    for (const s of [...(pa.sessions || [])].reverse()) {
      if (drop <= 0) break;
      if (String(s.serviceId) === String(m.serviceId) && s.status === 'Scheduled' && !s.bookingId) { s.status = 'Cancelled'; drop -= 1; }
    }
  }
  return target_pa;
}

function refund(pa, { amount, method = 'Cash', reference = null, reason = '', by = 'Admin' } = {}) {
  if (pa.status === 'Cancelled') throw Object.assign(new Error('This package is already cancelled.'), { status: 409 });
  const amt = r2(amount);
  if (!(amt >= 0)) throw Object.assign(new Error('Enter the refund amount.'), { status: 400 });
  if (!String(reason || '').trim()) throw Object.assign(new Error('Give a reason for the refund.'), { status: 400 });
  pa.refund = { refundedAt: new Date(), amount: amt, method, reference: reference || null, reason, byName: by };
  pa.status = 'Cancelled';
  pa.cancellation = { isCancelled: true, cancelledAt: new Date(), cancelledBy: by, reason: `Refund ₹${amt}: ${reason}` };
  for (const s of pa.sessions || []) if (s.status === 'Scheduled' && !s.bookingId) s.status = 'Cancelled';
  return pa;
}

/** Suggested refund: unused share of what was paid (Zenoti prorates by balance). */
function refundSuggestion(pa) {
  const rows = pa.serviceBalances();
  const total = rows.reduce((n, r) => n + r.entitled - r.transferred, 0);
  const left = rows.reduce((n, r) => n + r.balance, 0);
  const paid = Number(pa.payment?.amountPaid ?? (pa.payment?.isReceived ? pa.pricing?.finalAmount : 0)) || 0;
  return { paid, unitsTotal: total, unitsLeft: left, suggested: total > 0 ? r2(paid * left / total) : 0 };
}

function recordRedemption(pa, { serviceId, serviceName, sessionId = null, bookingId = null, invoiceId = null, invoiceNumber = null, branchId = null, byName = null }) {
  pa.redemptions = [...(pa.redemptions || []), { at: new Date(), serviceId: String(serviceId), serviceName: serviceName || null, sessionId, bookingId, invoiceId, invoiceNumber, branchId, byName }];
}

function reverseRedemption(pa, { sessionId = null, invoiceId = null }) {
  for (const r of pa.redemptions || []) {
    if (r.reversed) continue;
    if ((sessionId && String(r.sessionId) === String(sessionId)) || (invoiceId && String(r.invoiceId) === String(invoiceId))) r.reversed = true;
  }
}

module.exports = { buildAssignment, buildSessionRows, freeze, unfreeze, transfer, refund, refundSuggestion, recordRedemption, reverseRedemption };
