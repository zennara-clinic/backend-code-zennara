/**
 * The desk's "who is this guest" strip: what Zenoti shows the moment a guest
 * is picked in New Appointment — total visits, last visit, usual doctor,
 * open bookings, amount due, live packages, membership.
 *
 * Computed from our own records (which include every mirrored Zenoti visit),
 * so it is the same answer for an app guest and a clinic-only guest.
 */
const Booking = require('../models/Booking');
const PackageAssignment = require('../models/PackageAssignment');
const User = require('../models/User');

const LIVE = ['Awaiting Confirmation', 'Confirmed', 'Rescheduled', 'In Progress'];

/** Record that a guest attended on `at` (idempotent: keeps the latest). */
async function touchLastVisit(userId, at = new Date()) {
  if (!userId) return;
  const when = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(when.getTime())) return;
  await User.updateOne({ _id: userId }, { $max: { lastVisitAt: when } }).catch(() => {});
}

async function getGuestStats(userId) {
  const [user, bookings, packages] = await Promise.all([
    User.findById(userId).select('memberType zenMembershipExpiryDate lastVisitAt referralSource totalSpent').lean(),
    Booking.find({ userId, status: { $in: ['Completed', ...LIVE] } })
      .select('status preferredDate confirmedDate checkOutTime specialistId specialistName amount paymentStatus consultationId externalServiceName')
      .sort({ preferredDate: -1 }).limit(500).lean(),
    PackageAssignment.find({ userId, status: 'Active' }).select('packageDetails.packageName sessions usageTracking validUntil payment.isReceived pricing.finalAmount').lean(),
  ]);
  if (!user) return null;

  const completed = bookings.filter((b) => b.status === 'Completed');
  const open = bookings.filter((b) => LIVE.includes(b.status));
  const last = completed[0] || null;
  const lastVisitAt = user.lastVisitAt || (last ? (last.checkOutTime || last.confirmedDate || last.preferredDate) : null);

  // Usual doctor = most frequent dermatologist across completed visits.
  const byDoctor = new Map();
  completed.forEach((b) => {
    const key = b.specialistId || b.specialistName; if (!key) return;
    const cur = byDoctor.get(key) || { doctorId: b.specialistId || null, name: b.specialistName || null, visits: 0 };
    cur.visits += 1; byDoctor.set(key, cur);
  });
  const usualDoctor = [...byDoctor.values()].sort((a, b) => b.visits - a.visits)[0] || null;

  // Amount due = unpaid completed/live visits with a value + unpaid packages.
  const dueBookings = bookings.filter((b) => (b.amount || 0) > 0 && b.paymentStatus !== 'paid' && b.paymentStatus !== 'refunded')
    .reduce((n, b) => n + (b.amount || 0), 0);
  const duePackages = packages.filter((p) => !p.payment?.isReceived).reduce((n, p) => n + (p.pricing?.finalAmount || 0), 0);

  const nextOpen = open.sort((a, b) => new Date(a.preferredDate) - new Date(b.preferredDate))[0] || null;

  return {
    totalVisits: completed.length,
    lastVisitAt,
    lastVisitService: last ? (last.externalServiceName || null) : null,
    usualDoctor,
    openBookings: open.length,
    nextBookingAt: nextOpen ? nextOpen.preferredDate : null,
    amountDue: dueBookings + duePackages,
    amountDueBreakdown: { bookings: dueBookings, packages: duePackages },
    activePackages: packages.map((p) => ({
      name: p.packageDetails?.packageName || null,
      remaining: p.usageTracking?.remainingSessions ?? null,
      total: p.usageTracking?.totalSessions ?? null,
      validUntil: p.validUntil || null,
    })),
    membership: user.memberType === 'Zen Member'
      ? { active: !user.zenMembershipExpiryDate || new Date(user.zenMembershipExpiryDate) >= new Date(), expiresAt: user.zenMembershipExpiryDate || null }
      : null,
    referralSource: user.referralSource || null,
    totalSpent: user.totalSpent || 0,
  };
}

module.exports = { getGuestStats, touchLastVisit };
