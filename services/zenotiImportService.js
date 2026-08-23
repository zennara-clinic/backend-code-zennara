/**
 * Zenoti → local import.
 *
 * Two jobs, both idempotent and resumable:
 *
 *  1. importRoster()      — walk every centre's guest list and mirror each guest
 *                           into a local User (source: 'zenoti'). After this the
 *                           clinic's customers are ordinary app users: they show
 *                           in the patients list, can sign in with their phone,
 *                           and everything keyed by userId works for them.
 *
 *  2. syncGuestDetails()  — pull one guest's appointments, purchases, memberships
 *                           and packages into ZenotiGuestData. crawlDetails()
 *                           does this for the stalest N guests; the scheduler
 *                           calls it continuously so the whole roster stays
 *                           within ~a day of Zenoti without hammering the API.
 *
 * Zenoti allows ~50 requests/minute (enforced in zenotiService). The roster is
 * ~70 pages; per-guest detail is 4 calls, so a full detail pass over ~7k guests
 * is the better part of a day — hence the rolling crawl rather than a batch.
 */
const User = require('../models/User');
const ZenotiGuestData = require('../models/ZenotiGuestData');
const ZenotiSyncRun = require('../models/ZenotiSyncRun');
const zenoti = require('./zenotiService');
const { provisionUserFromGuest, applyMembershipFromZenoti, isMembershipCurrentlyActive } = require('./zenotiSyncService');
const { CENTERS, branchNameForCenter } = require('../config/zenoti');
const logger = require('../utils/logger');

const PAGE_SIZE = 100;
const DETAIL_TTL_MS = 24 * 60 * 60 * 1000; // re-crawl a guest once a day

let rosterRunning = false;
let detailsRunning = false;

function isRosterRunning() { return rosterRunning; }
function isDetailsRunning() { return detailsRunning; }

/* ------------------------------------------------------------------------ *
 * Roster
 * ------------------------------------------------------------------------ */

async function importRoster({ trigger = 'schedule', adminId = null } = {}) {
  if (!zenoti.isConfigured()) throw new Error('Zenoti integration is not configured.');
  if (rosterRunning) {
    const err = new Error('A roster import is already running.');
    err.code = 'ALREADY_RUNNING';
    throw err;
  }
  rosterRunning = true;
  const run = await ZenotiSyncRun.create({ type: 'roster', trigger, startedBy: adminId });
  const tally = { total: 0, processed: 0, created: 0, updated: 0, skipped: 0, failed: 0 };
  const seen = new Set();

  try {
    for (const centerId of Object.keys(CENTERS)) {
      let page = 1;
      let centerTotal = Infinity;
      for (;;) {
        const { guests, total } = await zenoti.listCenterGuests(centerId, page, PAGE_SIZE);
        if (page === 1) { centerTotal = total; tally.total += total; await run.updateOne({ total: tally.total }); }
        if (!guests.length) break;

        // One round of lookups for the whole page instead of three per guest.
        const ids = guests.map((g) => g.zenotiGuestId);
        const phones = guests.map((g) => g.phone).filter(Boolean);
        const emails = guests.map((g) => g.email && g.email.toLowerCase().trim()).filter(Boolean);
        const candidates = await User.find({
          $or: [{ zenotiGuestId: { $in: ids } }, { phone: { $in: phones } }, { email: { $in: emails } }],
        });
        const prefetched = { byGuest: new Map(), byPhone: new Map(), byEmail: new Map() };
        const stubOps = [];
        for (const u of candidates) {
          if (u.zenotiGuestId) prefetched.byGuest.set(u.zenotiGuestId, u);
          if (u.phone && !prefetched.byPhone.has(u.phone)) prefetched.byPhone.set(u.phone, u);
          if (u.email) prefetched.byEmail.set(u.email, u);
        }

        for (const guest of guests) {
          if (seen.has(guest.zenotiGuestId)) continue; // same guest listed under two centres
          seen.add(guest.zenotiGuestId);
          tally.processed += 1;
          try {
            if (!guest.centerId) guest.centerId = centerId;
            const user = await provisionUserFromGuest(guest, { quiet: true, prefetched });
            // A guest created on this page must be visible to later guests sharing its email/phone.
            if (user._importOutcome === 'created') { prefetched.byEmail.set(user.email, user); if (user.phone) prefetched.byPhone.set(user.phone, user); }
            if (user._importOutcome === 'created') tally.created += 1;
            else if (user._importOutcome === 'updated') tally.updated += 1;
            // Make sure the detail crawl knows about this guest.
            stubOps.push({
              updateOne: {
                filter: { userId: user._id },
                update: {
                  $setOnInsert: { zenotiGuestId: guest.zenotiGuestId, syncedAt: null },
                  $set: { centerId: guest.centerId || null, branchName: branchNameForCenter(guest.centerId) || null },
                },
                upsert: true,
              },
            });
          } catch (err) {
            if (err.code === 'NO_PHONE') tally.skipped += 1;
            else {
              tally.failed += 1;
              logger.warn('Zenoti roster: guest import failed', { guestId: guest.zenotiGuestId, error: err.message });
            }
          }
        }
        if (stubOps.length) await ZenotiGuestData.bulkWrite(stubOps, { ordered: false }).catch((e) => logger.warn('Zenoti roster: stub upsert failed', { error: e.message }));
        await run.updateOne({ ...tally });
        // Zenoti sometimes returns 99 on a full page, so a short page is NOT the
        // end — trust the centre-wide total and keep going until it's covered.
        if (page * PAGE_SIZE >= centerTotal) break;
        page += 1;
        if (page > 500) break; // safety stop
      }
    }
    await run.updateOne({ ...tally, status: 'completed', finishedAt: new Date() });
    logger.info('Zenoti roster import finished', tally);
    return { runId: run._id, ...tally };
  } catch (err) {
    await run.updateOne({ ...tally, status: 'failed', error: err.message, finishedAt: new Date() });
    logger.error('Zenoti roster import failed', { error: err.message, ...tally });
    throw err;
  } finally {
    rosterRunning = false;
  }
}

/* ------------------------------------------------------------------------ *
 * Per-guest history
 * ------------------------------------------------------------------------ */

const sum = (arr, f) => arr.reduce((n, x) => n + (Number(f(x)) || 0), 0);
const isActivePackage = (p) => {
  if (p.neverExpires) return (p.sessionsRemaining ?? 0) > 0;
  if (p.endDate) return new Date(p.endDate) >= new Date() && (p.sessionsRemaining ?? 0) > 0;
  return (p.sessionsRemaining ?? 0) > 0;
};

function computeStats({ appointments, orders, memberships, packages }) {
  const now = Date.now();
  const past = appointments.filter((a) => a.startTime && new Date(a.startTime).getTime() <= now);
  const future = appointments.filter((a) => a.startTime && new Date(a.startTime).getTime() > now);
  const activePkgs = packages.filter(isActivePackage);
  const lastVisit = past.length ? new Date(past[0].startTime) : null;
  const nextVisit = future.length ? new Date(future[future.length - 1].startTime) : null;
  return {
    treatmentsDone: past.length,
    upcoming: future.length,
    productsBought: sum(orders, (o) => o.quantity ?? 1),
    activePackages: activePkgs.length,
    sessionsLeft: sum(activePkgs, (p) => p.sessionsRemaining),
    activeMemberships: memberships.filter(isMembershipCurrentlyActive).length,
    lifetimeSpend: sum(past, (a) => a.price) + sum(orders, (o) => o.price) + sum(packages, (p) => p.price),
    lastVisit,
    nextVisit,
  };
}

/**
 * Refresh one user's Zenoti history into ZenotiGuestData.
 * @param {import('mongoose').Document|object} user — needs _id, zenotiGuestId, zenotiCenterId
 * @returns {Promise<object|null>} the mirror doc (lean), or null when not a Zenoti guest
 */
async function syncGuestDetails(user) {
  if (!user?.zenotiGuestId || !zenoti.isConfigured()) return null;
  const gid = user.zenotiGuestId;
  const centerId = user.zenotiCenterId || null;
  const errors = [];
  const safe = (label, p) => p.catch((e) => { errors.push(`${label}: ${e.message}`); return []; });

  const [appointments, orders, memberships, packages] = await Promise.all([
    safe('appointments', zenoti.getGuestAppointments(gid)),
    safe('orders', zenoti.getGuestProducts(gid)),
    safe('memberships', centerId ? zenoti.getGuestMemberships(gid, centerId) : Promise.resolve([])),
    safe('packages', zenoti.getGuestPackages(gid)),
  ]);

  const stats = computeStats({ appointments, orders, memberships, packages });
  const doc = await ZenotiGuestData.findOneAndUpdate(
    { userId: user._id },
    {
      $set: {
        zenotiGuestId: gid,
        centerId,
        branchName: branchNameForCenter(centerId) || null,
        appointments, orders, memberships, packages, stats,
        syncedAt: new Date(),
        lastError: errors.length ? errors.join('; ') : null,
      },
    },
    { upsert: true, new: true, lean: true }
  );

  // Keep the local account's visit counters and Zen membership in step.
  try {
    const fullUser = typeof user.save === 'function' ? user : await User.findById(user._id);
    if (fullUser) {
      if (stats.treatmentsDone > (fullUser.totalVisits || 0)) fullUser.totalVisits = stats.treatmentsDone;
      if (stats.lifetimeSpend > (fullUser.totalSpent || 0)) fullUser.totalSpent = stats.lifetimeSpend;
      if (fullUser.isModified()) await fullUser.save({ validateModifiedOnly: true });
      await applyMembershipFromZenoti(fullUser, memberships);
    }
  } catch (err) {
    logger.warn('Zenoti detail sync: user counters not updated', { userId: user._id, error: err.message });
  }
  return doc;
}

/**
 * Return the mirror for a user, refreshing it first when missing or older than
 * `maxAgeMs`. Staff opening a patient get fresh data; lists read the cache.
 */
async function getGuestDetails(user, { maxAgeMs = DETAIL_TTL_MS, refresh = false } = {}) {
  if (!user?.zenotiGuestId) return null;
  const existing = await ZenotiGuestData.findOne({ userId: user._id }).lean();
  const stale = !existing?.syncedAt || Date.now() - new Date(existing.syncedAt).getTime() > maxAgeMs;
  if (!refresh && !stale) return existing;
  try {
    return await syncGuestDetails(user);
  } catch (err) {
    logger.warn('Zenoti getGuestDetails refresh failed; serving cached copy', { userId: user._id, error: err.message });
    return existing;
  }
}

/**
 * Sync the `limit` stalest guests. Called every few minutes by the scheduler;
 * with ~4 Zenoti calls per guest and a 50/min budget, 40 guests ≈ 3–4 minutes.
 */
async function crawlDetails({ limit = 40, trigger = 'schedule' } = {}) {
  if (!zenoti.isConfigured() || detailsRunning) return null;
  detailsRunning = true;
  const tally = { total: 0, processed: 0, updated: 0, failed: 0, skipped: 0, created: 0 };
  const run = await ZenotiSyncRun.create({ type: 'details', trigger });
  try {
    // Users linked to Zenoti but with no mirror row yet come first, then the stalest.
    const linked = await User.find({ zenotiGuestId: { $exists: true, $ne: null } })
      .select('_id zenotiGuestId zenotiCenterId totalVisits totalSpent memberType zenMembershipStartDate zenMembershipExpiryDate')
      .lean();
    const mirrors = await ZenotiGuestData.find({ userId: { $in: linked.map((u) => u._id) } })
      .select('userId syncedAt').lean();
    const syncedAt = new Map(mirrors.map((m) => [String(m.userId), m.syncedAt ? new Date(m.syncedAt).getTime() : 0]));
    const cutoff = Date.now() - DETAIL_TTL_MS;
    const due = linked
      .map((u) => ({ u, at: syncedAt.get(String(u._id)) ?? 0 }))
      .filter((x) => x.at < cutoff)
      .sort((a, b) => a.at - b.at)
      .slice(0, limit)
      .map((x) => x.u);
    tally.total = due.length;
    await run.updateOne({ total: due.length });

    for (const u of due) {
      tally.processed += 1;
      try {
        await syncGuestDetails(u);
        tally.updated += 1;
      } catch (err) {
        tally.failed += 1;
        await ZenotiGuestData.updateOne({ userId: u._id }, { $set: { lastError: err.message, syncedAt: new Date() } }, { upsert: true });
      }
    }
    await run.updateOne({ ...tally, status: 'completed', finishedAt: new Date() });
    return tally;
  } catch (err) {
    await run.updateOne({ ...tally, status: 'failed', error: err.message, finishedAt: new Date() });
    logger.error('Zenoti detail crawl failed', { error: err.message });
    return tally;
  } finally {
    detailsRunning = false;
  }
}

/** Snapshot for the panel's sync-health card. */
async function getStatus() {
  const [linked, mirrored, fresh, withErrors, lastRoster, lastDetails, running] = await Promise.all([
    User.countDocuments({ zenotiGuestId: { $exists: true, $ne: null } }),
    ZenotiGuestData.countDocuments({ syncedAt: { $ne: null } }),
    ZenotiGuestData.countDocuments({ syncedAt: { $gte: new Date(Date.now() - DETAIL_TTL_MS) } }),
    ZenotiGuestData.countDocuments({ lastError: { $ne: null } }),
    ZenotiSyncRun.findOne({ type: 'roster' }).sort({ startedAt: -1 }).lean(),
    ZenotiSyncRun.findOne({ type: 'details', status: 'completed' }).sort({ startedAt: -1 }).lean(),
    ZenotiSyncRun.find({ status: 'running' }).sort({ startedAt: -1 }).lean(),
  ]);
  return {
    configured: zenoti.isConfigured(),
    writeMode: process.env.ZENOTI_WRITE_MODE || 'dryrun',
    linkedUsers: linked,
    mirrored,
    freshWithin24h: fresh,
    withErrors,
    rosterRunning,
    detailsRunning,
    lastRoster,
    lastDetails,
    running,
  };
}

module.exports = {
  importRoster,
  syncGuestDetails,
  getGuestDetails,
  crawlDetails,
  getStatus,
  isRosterRunning,
  isDetailsRunning,
  DETAIL_TTL_MS,
};
