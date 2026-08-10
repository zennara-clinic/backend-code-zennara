/**
 * Zenoti ↔ local account bridge.
 *
 * Bridges a Zenoti guest to a local User document so that a customer who already
 * exists in the Zenoti CRM can sign in to the app without registering. The local
 * mirror carries just enough identity for the rest of the app (which keys
 * everything off our userId) to work; the guest's live history stays in Zenoti
 * and is read on demand.
 *
 * Idempotent: linking is resolved by Zenoti guest id first, then phone, then
 * email, so repeated logins never create duplicate accounts or trip the unique
 * email/phone indexes.
 */

const User = require('../models/User');
const Branch = require('../models/Branch');
const zenoti = require('./zenotiService');
const {
  DEFAULT_BRANCH_NAME,
  normalizeIndianMobile,
  isZenMembership,
  isActiveMembershipStatus,
} = require('../config/zenoti');
const logger = require('../utils/logger');

/**
 * Resolve the mapped branch name to an actual active Branch document's name,
 * falling back sensibly so `location` always points at something real.
 */
async function resolveBranchName(preferredName) {
  const candidates = [preferredName, DEFAULT_BRANCH_NAME].filter(Boolean);
  for (const name of candidates) {
    const branch = await Branch.findOne({
      name: new RegExp(`^${escapeRegExp(name)}$`, 'i'),
      isActive: true,
    }).select('name');
    if (branch) return branch.name;
  }
  // Nothing matched — fall back to any active branch, then the raw preferred name.
  const any = await Branch.findOne({ isActive: true }).select('name');
  return any?.name || preferredName || DEFAULT_BRANCH_NAME;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A stable placeholder email when a Zenoti guest has none on file. */
function placeholderEmail(guestId) {
  return `zenoti_${guestId}@guest.zennara.in`.toLowerCase();
}

/**
 * Create or update the local User mirror for a normalised Zenoti guest.
 * @param {object} guest  output of zenotiService.normalizeGuest
 * @param {object} [opts] { phone } — the exact 10-digit phone used to sign in
 * @returns {Promise<import('mongoose').Document>} the local user
 */
async function provisionUserFromGuest(guest, opts = {}) {
  if (!guest || !guest.zenotiGuestId) {
    throw new Error('provisionUserFromGuest requires a guest with a zenotiGuestId');
  }

  const phone = normalizeIndianMobile(opts.phone) || guest.phone || null;
  const email = (guest.email || placeholderEmail(guest.zenotiGuestId)).toLowerCase().trim();
  const location = await resolveBranchName(guest.branchName);

  // Fields we keep in sync from Zenoti on every login.
  const synced = {
    zenotiGuestId: guest.zenotiGuestId,
    zenotiCenterId: guest.centerId || null,
    zenotiSyncedAt: new Date(),
    source: 'zenoti',
  };
  if (guest.fullName) synced.fullName = guest.fullName;
  if (guest.gender) synced.gender = guest.gender;
  if (guest.dateOfBirth) synced.dateOfBirth = guest.dateOfBirth;

  // 1) Already linked by Zenoti guest id → update the mirror.
  let user = await User.findOne({ zenotiGuestId: guest.zenotiGuestId });

  // 2) A local account with the same phone/email predates the link → adopt it.
  if (!user && phone) user = await User.findOne({ phone });
  if (!user && email) user = await User.findOne({ email });

  if (user) {
    Object.assign(user, synced);
    // Only fill identity gaps; never clobber values the customer set in-app.
    if (!user.email) user.email = email;
    if (!user.phone && phone) user.phone = phone;
    if (!user.location) user.location = location;
    await user.save({ validateModifiedOnly: true });
    logger.info('Linked existing local account to Zenoti guest', { userId: user._id });
    return user;
  }

  // 3) Brand-new mirror.
  user = await User.create({
    email,
    fullName: guest.fullName || 'Zennara Guest',
    phone: phone || undefined,
    location,
    gender: guest.gender || undefined,
    dateOfBirth: guest.dateOfBirth || undefined,
    memberType: 'Regular Member',
    phoneVerified: false,
    // Zenoti guests have already accepted Zennara's terms at the clinic; record
    // implied consent so downstream consent checks don't block them. Adjust if
    // you want to force re-consent in-app.
    privacyPolicyConsent: { accepted: true, version: 'zenoti-import', acceptedAt: new Date() },
    termsOfServiceConsent: { accepted: true, version: 'zenoti-import', acceptedAt: new Date() },
    ...synced,
  });
  logger.info('Provisioned new local account from Zenoti guest', { userId: user._id });
  return user;
}

/**
 * Look a customer up in Zenoti by phone and, if present, ensure a linked local
 * account exists. Returns the local user, or null when the number isn't a
 * Zenoti guest.
 */
async function findOrProvisionByPhone(phone) {
  if (!zenoti.isConfigured()) return null;
  try {
    const guest = await zenoti.findGuestByPhone(phone);
    if (!guest) return null;
    return await provisionUserFromGuest(guest, { phone });
  } catch (err) {
    logger.error('Zenoti findOrProvisionByPhone failed', { error: err.message });
    return null; // Never let a CRM hiccup break login for app-native users.
  }
}

/**
 * A Zenoti membership counts as active if its expiry is in the future. Zenoti's
 * numeric status codes aren't reliably documented, so we trust the expiry date
 * (which we do get) and only fall back to the status when there's no expiry.
 */
function isMembershipCurrentlyActive(m) {
  if (m.expiryDate) {
    const exp = new Date(m.expiryDate);
    if (!Number.isNaN(exp.getTime())) return exp.getTime() > Date.now();
  }
  return isActiveMembershipStatus(m.status);
}

/**
 * Reflect a guest's Zenoti membership into the app's Zen Member tier.
 *
 * On login we look up the guest's Zenoti memberships and check whether any Zen
 * membership is active. A Zen membership may be *named* anything (a real one is
 * "MVP") but is *coded* as a zen member, so we match on BOTH the display name and
 * the code (see isZenMembership / ZENOTI_ZEN_MEMBERSHIP_NAMES). If an active one
 * exists we mark them a Zen Member and carry its start (member-since) + expiry
 * across, so the profile shows their plan and validity. If none is active, we
 * leave them as-is — the profile then shows the normal "Upgrade to Zen" CTA.
 *
 * We only *upgrade* here — we never auto-downgrade a membership the customer may
 * have bought in-app. Downgrade-on-expiry, if wanted, is a deliberate follow-up.
 *
 * @returns {Promise<boolean>} whether anything changed.
 */
async function applyMembershipFromZenoti(user) {
  if (!user?.zenotiGuestId || !zenoti.isConfigured()) return false;
  try {
    const memberships = await zenoti.getGuestMemberships(user.zenotiGuestId, user.zenotiCenterId);
    const zenMemberships = memberships.filter(
      (m) => isZenMembership(m.name) || isZenMembership(m.code)
    );
    // Prefer an active one; among actives, the one that expires latest.
    const active = zenMemberships
      .filter(isMembershipCurrentlyActive)
      .sort((a, b) => new Date(b.expiryDate || 0) - new Date(a.expiryDate || 0))[0];
    if (!active) return false;

    let changed = false;
    if (user.memberType !== 'Zen Member') {
      user.memberType = 'Zen Member';
      changed = true;
    }
    if (active.memberSince) {
      const start = new Date(active.memberSince);
      if (!Number.isNaN(start.getTime())) { user.zenMembershipStartDate = start; changed = true; }
    }
    if (active.expiryDate) {
      const end = new Date(active.expiryDate);
      if (!Number.isNaN(end.getTime())) { user.zenMembershipExpiryDate = end; changed = true; }
    }
    if (changed) {
      await user.save({ validateModifiedOnly: true });
      logger.info('Applied Zenoti Zen membership to user', { userId: user._id, plan: active.name });
    }
    return changed;
  } catch (err) {
    logger.warn('applyMembershipFromZenoti failed (non-blocking)', { userId: user._id, error: err.message });
    return false;
  }
}

/**
 * Refresh the local mirror of an already-linked user from Zenoti.
 * Safe to call in the background after login. Also reflects their Zen membership.
 */
async function syncLinkedUser(user) {
  if (!user?.zenotiGuestId || !zenoti.isConfigured()) return user;
  try {
    const guest = await zenoti.getGuest(user.zenotiGuestId);
    const fresh = guest ? await provisionUserFromGuest(guest, { phone: user.phone }) : user;
    await applyMembershipFromZenoti(fresh);
    return fresh;
  } catch (err) {
    logger.warn('Zenoti syncLinkedUser failed (non-blocking)', { userId: user._id, error: err.message });
  }
  return user;
}

module.exports = {
  provisionUserFromGuest,
  findOrProvisionByPhone,
  syncLinkedUser,
  applyMembershipFromZenoti,
  resolveBranchName,
};
