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
  placeholderEmail,
  isPlaceholderEmail,
} = require('../config/zenoti');
const logger = require('../utils/logger');

/**
 * Resolve the mapped branch name to an actual active Branch document's name,
 * falling back sensibly so `location` always points at something real.
 */
const branchNameCache = new Map();
async function resolveBranchName(preferredName) {
  const key = preferredName || '';
  if (branchNameCache.has(key)) return branchNameCache.get(key);
  const value = await resolveBranchNameUncached(preferredName);
  branchNameCache.set(key, value);
  setTimeout(() => branchNameCache.delete(key), 10 * 60 * 1000).unref?.();
  return value;
}
async function resolveBranchNameUncached(preferredName) {
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

  // The bulk importer pre-loads a page's worth of candidate accounts so we
  // don't pay three round-trips per guest; otherwise look them up here.
  const pre = opts.prefetched || null;
  const lookup = (key, value) => {
    if (pre) return Promise.resolve(pre[key].get(value) || null);
    if (key === 'byGuest') {
      // Historical imports preserved Zenoti's GUID casing while the current
      // normaliser lowercases it. GUID identity is case-insensitive.
      return User.findOne({ zenotiGuestId: new RegExp(`^${escapeRegExp(value)}$`, 'i') });
    }
    return User.findOne({ [key === 'byPhone' ? 'phone' : 'email']: value });
  };

  // 1) Already linked by Zenoti guest id → update the mirror.
  let user = await lookup('byGuest', guest.zenotiGuestId);

  // 2) A local account with the same phone/email predates the link → adopt it.
  //    Never steal an account that is already linked to a DIFFERENT guest —
  //    families share emails in the CRM, and the bulk import must not merge them.
  const unlinked = (u) => u && (!u.zenotiGuestId || String(u.zenotiGuestId).toLowerCase() === String(guest.zenotiGuestId).toLowerCase());
  if (!user && phone) {
    const byPhone = await lookup('byPhone', phone);
    if (unlinked(byPhone)) user = byPhone;
  }
  if (!user && email) {
    const byEmail = await lookup('byEmail', email);
    // A placeholder email is deterministically derived from this exact Zenoti
    // guest id. If an old partial import created it but failed to persist (or
    // differently cased) the guest id, this is still the same patient record.
    if (unlinked(byEmail) || (byEmail && email === placeholderEmail(guest.zenotiGuestId))) user = byEmail;
  }

  if (user) {
    const before = user.toObject();
    Object.assign(user, synced);
    // Only fill identity gaps; never clobber values the customer set in-app.
    // A placeholder address IS a gap: when Zenoti now has a real email for
    // this guest, adopt it (unless another account already holds it — the
    // unique index would reject the save and the whole sync would fail).
    if (!user.email) user.email = email;
    else if (isPlaceholderEmail(user.email) && guest.email && !isPlaceholderEmail(email)) {
      const taken = pre ? Boolean(pre.byEmail.get(email)) : await User.exists({ email, _id: { $ne: user._id } });
      if (!taken) user.email = email;
    }
    if (!user.phone && phone) user.phone = phone;
    if (!user.location) user.location = location;
    const changed = ['fullName', 'gender', 'dateOfBirth', 'zenotiGuestId', 'zenotiCenterId', 'location', 'email', 'phone']
      .some((k) => String(before[k] ?? '') !== String(user[k] ?? ''));
    user.$locals.skipZenotiWrite = true;
    await user.save({ validateModifiedOnly: true });
    if (!opts.quiet) logger.info('Linked existing local account to Zenoti guest', { userId: user._id });
    user._importOutcome = changed ? 'updated' : 'unchanged';
    return user;
  }

  // 3) Brand-new mirror. A guest with no valid mobile is still a real clinic
  //    patient and must appear in the admin panel. The conditional User
  //    validator permits a missing phone only for source:'zenoti'; OTP login
  //    naturally remains unavailable until a valid number is added.
  // The CRM email may already belong to another (differently linked) account;
  // fall back to the stable placeholder rather than failing the unique index.
  const emailTaken = pre ? Boolean(pre.byEmail.get(email)) : await User.exists({ email });
  user = new User({
    email: emailTaken ? placeholderEmail(guest.zenotiGuestId) : email,
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
  user.$locals.skipZenotiWrite = true;
  await user.save();
  if (!opts.quiet) logger.info('Provisioned new local account from Zenoti guest', { userId: user._id });
  user._importOutcome = 'created';
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
 * A Zenoti membership is active only when its explicit status is active and it
 * has not expired. This matters for cancelled/refunded memberships whose old
 * expiry date can still be in the future.
 */
function isMembershipCurrentlyActive(m) {
  if (m.status !== undefined && m.status !== null && !isActiveMembershipStatus(m.status)) return false;
  if (m.expiryDate) {
    const exp = new Date(m.expiryDate);
    if (!Number.isNaN(exp.getTime())) return exp.getTime() > Date.now();
  }
  return m.status !== undefined && m.status !== null ? isActiveMembershipStatus(m.status) : false;
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
async function applyMembershipFromZenoti(user, prefetched) {
  if (!user?.zenotiGuestId || !zenoti.isConfigured()) return false;
  try {
    const memberships = Array.isArray(prefetched)
      ? prefetched
      : await zenoti.getGuestMemberships(user.zenotiGuestId, user.zenotiCenterId);
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
    // Show it in the panel the same way as an app/clinic-desk membership.
    if (user.zenMembershipSource !== 'zenoti' || user.zenMembershipPlan !== (active.name || active.code)) {
      user.zenMembershipSource = 'zenoti';
      user.zenMembershipPlan = active.name || active.code || 'Zen membership';
      user.zenMembershipPaymentStatus = 'paid';
      user.zenMembershipPaymentMethod = user.zenMembershipPaymentMethod || 'Zenoti';
      changed = true;
    }
    if (changed) {
      user.$locals.skipZenotiWrite = true;
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
  placeholderEmail,
  isMembershipCurrentlyActive,
  provisionUserFromGuest,
  findOrProvisionByPhone,
  syncLinkedUser,
  applyMembershipFromZenoti,
  resolveBranchName,
};
