/**
 * Zenoti guest memberships → the panel's member register.
 *
 * The clinic sells ONE membership (the Zen Membership). Zenoti has carried it
 * under several product rows over the years — "Zen Membership", "MVP",
 * "MVP-2026", "MVP Jh", "NEW MVP" — and a guest's copy of it lives only in
 * Zenoti's guest-memberships endpoint. Until now that copy reached us as a flag
 * on the User (memberType) and nothing else, so the panel's Memberships →
 * Members tab was empty and every plan read "0 members" while a hundred-odd
 * guests actually held one.
 *
 * This mirrors each Zenoti guest membership into a MembershipAssignment row
 * against the single Zen plan, so the desk sees the real register, the counts
 * are real, and credits/validity/status match Zenoti. Rows are keyed by
 * Zenoti's user_membership_id, so re-running is idempotent — a refresh updates
 * the row it created rather than adding another.
 *
 * Nothing is ever written back to Zenoti from here.
 */

const mongoose = require('mongoose');
const Membership = require('../models/Membership');
const MembershipAssignment = require('../models/MembershipAssignment');
const { isZenMembership, isActiveMembershipStatus } = require('../config/zenoti');
const { syncUserMembership } = require('../utils/membershipRules');
const logger = require('../utils/logger');

const ZEN_PLAN_CODE = 'ZEN-MEMBERSHIP';

/** The one plan every mirrored membership hangs off. Created if absent. */
async function zenPlan() {
  let plan = await Membership.findOne({ isAppDefault: true });
  if (!plan) plan = await Membership.findOne({ code: ZEN_PLAN_CODE });
  if (!plan) {
    plan = await Membership.create({
      name: 'Zen Membership', code: ZEN_PLAN_CODE, prefix: 'ZEN',
      source: 'zenoti', isAppDefault: true, isActive: true,
    });
  }
  return plan;
}

const slug = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'service';

/**
 * Active / Expired / Cancelled, decided the way the clinic reads it: Zenoti's
 * own status first (1 = active, 5 = expired), then the expiry date. A refunded
 * membership is cancelled whatever its dates say.
 */
function statusOf(m, at = new Date()) {
  if (m.isRefunded) return 'Cancelled';
  const expiry = m.expiryDate ? new Date(m.expiryDate) : null;
  const expired = expiry && !Number.isNaN(expiry.getTime()) && expiry.getTime() <= at.getTime();
  if (expired) return 'Expired';
  if (m.status !== undefined && m.status !== null && !isActiveMembershipStatus(m.status)) return 'Expired';
  return 'Active';
}

/**
 * What the guest paid. Zenoti's guest-membership payload does NOT carry the
 * amount — only the invoice it was sold on — so we fall back to the list price
 * of the Zenoti product row they hold, recorded on the plan by the catalogue
 * sync. It is the right order of magnitude and is labelled as a list price on
 * the row's notes; the invoice number is kept so the desk can check the bill.
 */
function priceFor(m, plan) {
  const variants = plan?.zenotiRaw?.variants;
  if (Array.isArray(variants)) {
    const hit = variants.find((v) => v.id === m.membershipId) || variants.find((v) => String(v.name || '').toLowerCase() === String(m.name || '').toLowerCase());
    if (hit && Number(hit.listPrice) > 0) return Number(hit.listPrice);
  }
  return Number(plan?.price) || 0;
}

/**
 * Mirror one guest's Zenoti memberships. `memberships` is the normalized array
 * from zenotiService.getGuestMemberships (or the cached copy on
 * ZenotiGuestData). Returns how many rows were written.
 */
async function mirrorGuestMemberships(userId, memberships, { plan = null } = {}) {
  if (!userId || !Array.isArray(memberships) || !memberships.length) return { upserted: 0, skipped: 0 };
  const p = plan || (await zenPlan());
  const rows = memberships.filter((m) => m?.id && (isZenMembership(m.name) || isZenMembership(m.code)));
  let upserted = 0;

  for (const m of rows) {
    try {
      const status = statusOf(m);
      const validFrom = m.memberSince ? new Date(m.memberSince) : null;
      const validUntil = m.expiryDate ? new Date(m.expiryDate) : null;
      const credits = (Array.isArray(m.services) ? m.services : [])
        .filter((s) => s?.name)
        .map((s) => ({
          serviceId: slug(s.name),
          serviceName: String(s.name).trim(),
          qty: Math.max(0, Number(s.total) || 0),
          used: Math.max(0, Number(s.used) || 0),
        }));
      const price = priceFor(m, p);

      const set = {
        userId,
        membershipId: p._id,
        snapshot: {
          name: p.name,
          // Zenoti's own product code for this guest's row — MVPJH, MVP-2026 …
          code: m.code || p.code,
          discounts: {
            servicesPercent: p.discounts?.servicesPercent || 0,
            productsPercent: p.discounts?.productsPercent || 0,
            packagesPercent: p.discounts?.packagesPercent || 0,
          },
          validityMonths: p.validityMonths || 12,
          branchIds: [],
        },
        credits,
        price,
        payment: {
          // Zenoti only issues a membership off a closed invoice.
          isReceived: true,
          receivedDate: validFrom,
          paymentMethod: 'Zenoti',
          amountPaid: price,
          balanceDue: 0,
        },
        status,
        validFrom: validFrom && !Number.isNaN(validFrom.getTime()) ? validFrom : new Date(),
        validUntil: validUntil && !Number.isNaN(validUntil.getTime()) ? validUntil : null,
        source: 'zenoti',
        zenotiUserMembershipId: m.id,
        zenotiInvoiceNumber: m.invoice?.number || null,
        notes: `Mirrored from Zenoti — sold as "${m.name || 'membership'}"${m.centerName ? ` at ${m.centerName}` : ''}${m.invoice?.number ? `, invoice ${m.invoice.number}` : ''}. Amount shown is the plan's Zenoti list price; Zenoti does not expose the per-guest amount.`,
      };
      if (status === 'Cancelled') set['cancellation.reason'] = 'Refunded in Zenoti';

      await MembershipAssignment.updateOne(
        { zenotiUserMembershipId: m.id },
        { $set: set, $setOnInsert: { memberNumber: null, autoRenew: false } },
        { upsert: true },
      );
      upserted += 1;
    } catch (error) {
      logger.warn('Zenoti membership mirror row failed', { userId: String(userId), zenotiUserMembershipId: m.id, error: error.message });
    }
  }

  // The summary the app and the profile read comes off these rows.
  if (upserted) await syncUserMembership(userId).catch(() => {});
  return { upserted, skipped: memberships.length - rows.length };
}

/** Keep the plan's stored members count in step with its Active rows. */
async function refreshMembersCount(planId = null) {
  const id = planId || (await zenPlan())._id;
  const n = await MembershipAssignment.countDocuments({
    membershipId: id,
    status: 'Active',
    $or: [{ validUntil: null }, { validUntil: { $gt: new Date() } }],
  });
  await Membership.updateOne({ _id: id }, { $set: { membersCount: n } });
  return n;
}

module.exports = { mirrorGuestMemberships, refreshMembersCount, zenPlan, statusOf, ZEN_PLAN_CODE };
