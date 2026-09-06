/**
 * Membership rules shared by the desk, the bill and the app.
 *
 *  • currentMembership(userId)  → the guest's live MembershipAssignment, or a
 *    "legacy" view built from User.zenMembership* + the app card's discount
 *    (guests who bought the Zen membership before plans existed keep their
 *    benefit on the bill).
 *  • discountPercentFor(m, kind) → % off a service / product / package line.
 *  • syncUserMembership(userId) → keeps User.memberType and zenMembership*
 *    (the summary the app reads) in step with the assignment rows.
 */
const User = require('../models/User');
const MembershipAssignment = require('../models/MembershipAssignment');

async function legacyDiscountPercent() {
  try {
    const AppCustomization = require('../models/AppCustomization');
    const doc = await AppCustomization.findOne().select('membership.discountPercent').lean();
    const p = Number(doc?.membership?.discountPercent);
    return Number.isFinite(p) ? p : 15;
  } catch { return 15; }
}

async function currentMembership(userId, { at = new Date() } = {}) {
  if (!userId) return null;
  const live = await MembershipAssignment.findOne({ userId, status: 'Active', $or: [{ validUntil: null }, { validUntil: { $gt: at } }] }).sort({ validUntil: -1 });
  if (live) return { kind: 'plan', assignment: live, name: live.snapshot?.name || 'Membership', memberNumber: live.memberNumber, validUntil: live.validUntil, discounts: live.snapshot?.discounts || {}, credits: live.creditBalances() };
  const user = await User.findById(userId).select('memberType zenMembershipExpiryDate zenMembershipPlan').lean();
  if (user?.memberType === 'Zen Member' && (!user.zenMembershipExpiryDate || new Date(user.zenMembershipExpiryDate) > at)) {
    const pct = await legacyDiscountPercent();
    return { kind: 'legacy', assignment: null, name: user.zenMembershipPlan || 'Zen Membership', memberNumber: null, validUntil: user.zenMembershipExpiryDate || null, discounts: { servicesPercent: pct, productsPercent: 0, packagesPercent: 0 }, credits: [] };
  }
  return null;
}

function discountPercentFor(m, kind) {
  if (!m) return 0;
  const d = m.discounts || {};
  if (kind === 'service') return Number(d.servicesPercent) || 0;
  if (kind === 'product') return Number(d.productsPercent) || 0;
  if (kind === 'package') return Number(d.packagesPercent) || 0;
  return 0;
}

/** Re-derive the guest's summary fields from their assignment rows. */
async function syncUserMembership(userId) {
  const user = await User.findById(userId);
  if (!user) return null;
  const now = new Date();
  const live = await MembershipAssignment.findOne({ userId, status: 'Active', $or: [{ validUntil: null }, { validUntil: { $gt: now } }] }).sort({ validUntil: -1 });
  if (live) {
    user.memberType = 'Zen Member';
    user.zenMembershipStartDate = live.validFrom || user.zenMembershipStartDate;
    user.zenMembershipExpiryDate = live.validUntil || null;
    user.zenMembershipAutoRenew = !!live.autoRenew;
    user.zenMembershipSource = live.source === 'zenoti' ? 'zenoti' : live.source === 'app' ? 'app' : 'admin';
    user.zenMembershipPlan = `${live.snapshot?.name || 'Membership'}${live.memberNumber ? ` · ${live.memberNumber}` : ''}`;
    user.zenMembershipMonths = live.snapshot?.validityMonths || user.zenMembershipMonths;
    user.zenMembershipAmount = live.price;
    user.zenMembershipPaymentMethod = live.payment?.paymentMethod || user.zenMembershipPaymentMethod;
    user.zenMembershipPaymentStatus = live.payment?.isReceived ? 'paid' : 'pending';
  } else {
    const anyRows = await MembershipAssignment.exists({ userId });
    // Only downgrade when the summary came from plan rows; a legacy app/Zenoti membership is left alone.
    if (anyRows && user.memberType === 'Zen Member' && user.zenMembershipExpiryDate && new Date(user.zenMembershipExpiryDate) <= now) user.memberType = 'Regular Member';
  }
  user.$locals.skipZenotiWrite = true;
  await user.save({ validateModifiedOnly: true });
  return user;
}

module.exports = { currentMembership, discountPercentFor, syncUserMembership, legacyDiscountPercent };
