const cron = require('node-cron');
const Booking = require('../models/Booking');
const emailService = require('./emailService');
const {
  addClinicDays, bookingScheduledAt, clinicDateKey, clinicDayEnd, clinicDayStart, formatClinicDate,
} = require('./bookingTime');

/**
 * Automatically delete expired bookings that are still in "Awaiting Confirmation" status
 * Runs every hour to clean up bookings where the preferred date/time has passed
 */
const cleanupExpiredBookings = async () => {
  try {
    console.log('🧹 Running booking cleanup scheduler...');
    
    const now = new Date();
    const currentDate = clinicDateKey(now);

    // Find all bookings that are:
    // 1. Still in "Awaiting Confirmation" status
    // 2. Preferred date is in the past OR (date is today AND time has passed)
    // 3. NOT paid, and not a package session.
    //
    // (3) is new. Since the desk now approves every booking before Zenoti sees
    // it, a paid dermatologist-slot booking sits in Awaiting Confirmation until
    // reception confirms it. Money has been taken for it; deleting it because
    // nobody pressed Confirm in time would erase a paid appointment and its
    // refund trail. Paid and package bookings are left for a person to
    // resolve — they show as overdue in the panel, never vanish.
    const expiredBookings = await Booking.find({
      status: 'Awaiting Confirmation',
      preferredDate: { $lte: clinicDayEnd(currentDate) },
      paymentStatus: { $ne: 'paid' },
      isPackageIncluded: { $ne: true },
    }).populate('consultationId', 'name');

    // Filter bookings where time has also passed (for today's bookings)
    const bookingsToDelete = [];
    
    for (const booking of expiredBookings) {
      const scheduledAt = bookingScheduledAt(booking);
      if (scheduledAt && scheduledAt < now) bookingsToDelete.push(booking);
    }

    if (bookingsToDelete.length === 0) {
      console.log('✅ No expired bookings to clean up');
      return;
    }

    console.log(`🗑️  Found ${bookingsToDelete.length} expired booking(s) to delete`);

    // Send notification emails before deletion
    for (const booking of bookingsToDelete) {
      try {
        await emailService.sendBookingExpiredNotification(
          booking.email,
          booking.fullName,
          {
            referenceNumber: booking.referenceNumber,
            treatment: booking.consultationId?.name || 'N/A',
            date: formatClinicDate(booking.preferredDate),
            time: booking.preferredTimeSlots[0],
            location: booking.preferredLocation
          }
        );
        console.log(`📧 Expiry notification sent to ${booking.email}`);
      } catch (emailError) {
        console.error(`⚠️  Failed to send email to ${booking.email}:`, emailError.message);
      }
    }

    // Delete the expired bookings
    const deletedIds = bookingsToDelete.map(b => b._id);
    const deleteResult = await Booking.deleteMany({ _id: { $in: deletedIds } });
    
    console.log(`✅ Successfully deleted ${deleteResult.deletedCount} expired booking(s)`);
    console.log(`   Reference Numbers: ${bookingsToDelete.map(b => b.referenceNumber).join(', ')}`);
    
  } catch (error) {
    console.error('❌ Error in booking cleanup scheduler:', error);
  }
};

/** "10:00 AM" from a Date; a date with no set time defaults to a 10 AM slot. */
/** "HH:mm" in clinic time — the diary keys slots on this, not on a label. */
function toHHMM(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(date));
  const get = (t) => parts.find((x) => x.type === t)?.value ?? '00';
  return `${get('hour')}:${get('minute')}`;
}

function formatSlotTime(date) {
  const h = date.getHours();
  const m = date.getMinutes();
  if (h === 0 && m === 0) return '10:00 AM';
  const period = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, '0')} ${period}`;
}

/**
 * Nudge customers to book their package sessions — the scheduler no longer
 * books them.
 *
 * Auto-creating the appointment 24 hours before a clinic-set date put a
 * Confirmed booking in the diary that the customer had never agreed to and the
 * desk had never looked at. The agreed flow is: the customer books the session
 * from the app, the desk confirms it, and that confirmation creates the Zenoti
 * appointment — exactly like any other booking.
 *
 * Two nudges, each sent once:
 *   · 24 hours before a session's suggested date: "book your session"
 *   · 30 days before the package expires, if sessions remain: "use it before…"
 *
 * Email always; WhatsApp best-effort (free-text delivery depends on the
 * customer having messaged the clinic within 24h, so failures are expected
 * and logged, never raised).
 */
const remindDuePackageSessions = async () => {
  try {
    const PackageAssignment = require('../models/PackageAssignment');
    const whatsapp = require('../services/whatsappService');
    const { clinicDateKey } = require('./bookingTime');

    const now = new Date();
    const dayAhead = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const monthAhead = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const assignments = await PackageAssignment.find({
      status: 'Active',
      $or: [
        { sessions: { $elemMatch: { status: 'Scheduled', bookingId: null, reminderSentAt: null, scheduledDate: { $gte: now, $lte: dayAhead } } } },
        { expiryReminderSentAt: null, validUntil: { $gte: now, $lte: monthAhead } },
      ],
    }).populate('userId', 'fullName email phone');

    let sent = 0;
    for (const a of assignments) {
      const name = a.userDetails?.fullName || a.userId?.fullName || 'there';
      const email = a.userDetails?.email || a.userId?.email || '';
      const phone = a.userDetails?.phone || a.userId?.phone || '';
      const realEmail = email && !/@zennara\.local$|@guest\.zennara\.in$/i.test(email);
      const pkgName = a.packageDetails?.name || 'your package';
      let touched = false;

      const deliver = async (subject, line1, line2) => {
        const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#111714;">
          <div style="font-size:12px;letter-spacing:2px;color:#032F22;font-weight:800;">ZENNARA</div>
          <h1 style="font-size:18px;margin:8px 0 12px;">${subject}</h1>
          <p style="font-size:14px;line-height:21px;">Hi ${name},</p>
          <p style="font-size:14px;line-height:21px;">${line1}</p>
          <p style="font-size:14px;line-height:21px;">${line2}</p>
          <p style="font-size:12px;color:#7A827E;margin-top:20px;">Open the Zennara app → Profile → My packages to choose a date and time. The clinic will confirm your slot.</p>
        </div>`;
        if (realEmail) await emailService.sendRawEmail(email, `${subject} — Zennara`, html).catch((e) => console.error('⚠️ package reminder email failed:', e.message));
        if (phone) await whatsapp.sendMessage(phone, `${subject}\n\nHi ${name}, ${line1} ${line2}\n\nOpen the Zennara app → Profile → My packages to book. The clinic will confirm your slot.`).catch(() => {});
        sent += 1;
      };

      for (const session of a.sessions) {
        if (session.status !== 'Scheduled' || session.bookingId || session.reminderSentAt || !session.scheduledDate) continue;
        const when = new Date(session.scheduledDate);
        if (when < now || when > dayAhead) continue;
        await deliver(
          'Book your next session',
          `your <b>${session.serviceName || 'treatment'}</b> session from ${pkgName} is suggested for <b>${clinicDateKey(when)}${session.scheduledTime ? ` · ${session.scheduledTime}` : ''}</b>.`,
          'Please book the session in the app so we can hold a time for you.',
        );
        session.reminderSentAt = new Date();
        touched = true;
      }

      if (!a.expiryReminderSentAt && a.validUntil && a.validUntil >= now && a.validUntil <= monthAhead) {
        const remaining = (a.sessions || []).filter((s) => !['Completed', 'Cancelled'].includes(s.status) && !s.bookingId).length;
        if (remaining > 0) {
          await deliver(
            'Your package expires soon',
            `${pkgName} is valid until <b>${clinicDateKey(a.validUntil)}</b> and you still have <b>${remaining}</b> session${remaining === 1 ? '' : 's'} to use.`,
            'Book them in the app before the package expires.',
          );
        }
        a.expiryReminderSentAt = new Date();
        touched = true;
      }

      if (touched) await a.save().catch((e) => console.error('⚠️ Assignment save failed:', e.message));
    }

    if (sent > 0) console.log(`📦 Sent ${sent} package reminder(s)`);
  } catch (error) {
    console.error('❌ Error in package reminder scheduler:', error);
  }
};

/**
 * Mark packages Expired once their validity has passed. Nothing else changes:
 * completed sessions stay completed, and the desk can still extend `validUntil`
 * from the panel, which re-activates the package at that moment.
 */
const expirePackages = async () => {
  try {
    const PackageAssignment = require('../models/PackageAssignment');
    const now = new Date();
    const expired = await PackageAssignment.updateMany(
      { status: 'Active', validUntil: { $ne: null, $lt: now } },
      { $set: { status: 'Expired' } },
    );
    // No automatic re-activation here: the desk may have marked a package
    // Expired on purpose. Extending validUntil from the panel is what brings a
    // package back (see packageAssignmentController.updateAssignment).
    if (expired.modifiedCount) {
      console.log(`📦 Packages: ${expired.modifiedCount} expired`);
    }
  } catch (error) {
    console.error('❌ Error expiring packages:', error);
  }
};

/**
 * Initialize the booking cleanup scheduler
 * Runs every hour at the start of the hour (0 minutes)
 */
const startBookingScheduler = () => {
  // Run every hour
  cron.schedule('0 * * * *', () => {
    cleanupExpiredBookings();
  });

  console.log('📅 Booking cleanup scheduler started - runs every hour');

  // Nudge customers to book package sessions (24h before a suggested date,
  // 30 days before expiry). Hourly is plenty — these are messages, not bookings.
  cron.schedule('5 * * * *', () => {
    remindDuePackageSessions();
  });
  // Expire packages whose validity has passed, just after midnight IST.
  cron.schedule('10 0 * * *', () => {
    expirePackages();
  }, { timezone: 'Asia/Kolkata' });

  console.log('📦 Package reminder scheduler started - hourly; expiry check nightly');

  /*
   * The daily clinic summary, 20:00 IST — after the last 18:00 slot has run,
   * so the day's completions and no-shows are already recorded.
   *
   * Pinned to Asia/Kolkata rather than the server's own clock: an EC2 box on
   * UTC would otherwise send this at 01:30 IST and report the wrong day.
   * Silently does nothing while DAILY_SUMMARY_RECIPIENTS is unset.
   */
  cron.schedule('0 20 * * *', () => {
    require('../services/dailySummaryService')
      .sendDailySummary({ trigger: 'schedule' })
      .catch(() => {});
  }, { timezone: 'Asia/Kolkata' });

  console.log('✉️  Daily clinic summary scheduled - 20:00 IST');

  // Also run immediately on server start
  cleanupExpiredBookings();
  expirePackages();
};

/**
 * Manual cleanup function that can be called from an API endpoint
 */
const manualCleanup = async () => {
  console.log('🔧 Manual cleanup triggered');
  await cleanupExpiredBookings();
};

module.exports = {
  startBookingScheduler,
  manualCleanup,
  cleanupExpiredBookings,
  remindDuePackageSessions
};

/* ---------------------------------------------------------------------------
 * Check-in codes for guests who never open the app.
 *
 * One hour before a confirmed slot, if no check-in code has been issued yet
 * (the app issues one when the guest opens the appointment), mint it and send
 * it by email + WhatsApp. Same code the app would show.
 * ------------------------------------------------------------------------- */
async function sendUpcomingCheckInCodes() {
  const Booking = require('../models/Booking');
  const visitCodes = require('./visitCodes');
  const now = new Date();
  const today = clinicDateKey(now);
  const dayStart = clinicDayStart(today);
  const dayEnd = clinicDayEnd(addClinicDays(today, 1));
  const candidates = await Booking.find({
    status: { $in: ['Confirmed', 'Rescheduled'] },
    checkInCodeSentAt: null,
    source: { $ne: 'zenoti' },
    $or: [{ confirmedDate: { $gte: dayStart, $lte: dayEnd } }, { confirmedDate: null, preferredDate: { $gte: dayStart, $lte: dayEnd } }],
  }).populate('consultationId', 'name');

  let sent = 0;
  for (const b of candidates) {
    const start = bookingScheduledAt(b);
    if (!start) continue;
    const lead = start.getTime() - now.getTime();
    if (lead > 65 * 60 * 1000 || lead < -30 * 60 * 1000) continue; // outside the 1h window
    try {
      const { delivered } = await visitCodes.deliver(b, 'checkin', { by: null });
      // Don't retry forever on guests with no contact details.
      if (!delivered.length) b.checkInCodeSentAt = new Date(0);
      await b.save();
      if (delivered.length) sent += 1;
    } catch (e) {
      console.error('⚠️ Check-in code auto-send failed:', b._id, e.message);
    }
  }
  if (sent) console.log(`📨 Sent ${sent} check-in code(s) for upcoming appointments`);
}

function startCheckInCodeJob() {
  cron.schedule('*/5 * * * *', () => {
    sendUpcomingCheckInCodes().catch((e) => console.error('Check-in code job failed:', e.message));
  });
}
module.exports.sendUpcomingCheckInCodes = sendUpcomingCheckInCodes;
module.exports.startCheckInCodeJob = startCheckInCodeJob;

/* ---------------------------------------------------------------------------
 * Refill reminders.
 *
 * A prescription line carries a duration ("14 days", "1 month") or an explicit
 * refill interval. Two days before that runs out the guest hears once — in-app,
 * on the phone, and on WhatsApp when they allow it — with a link straight back
 * to the prescription so "order again" is one tap. Only prescriptions signed in
 * the last six months are considered; older courses are long finished.
 * ------------------------------------------------------------------------- */
async function sendRefillReminders() {
  const ConsultationNote = require('../models/ConsultationNote');
  const User = require('../models/User');
  const NotificationHelper = require('./notificationHelper');
  const { refillDueAt } = require('../controllers/prescriptionController');
  const { allows } = require('../services/pushService');
  const whatsapp = require('../services/whatsappService');
  const now = Date.now();
  const soon = now + 2 * 86400000;
  const sixMonthsAgo = new Date(now - 183 * 86400000);
  const notes = await ConsultationNote.find({ status: 'Completed', completedAt: { $gte: sixMonthsAgo }, 'prescription.0': { $exists: true } })
    .select('userId doctorName completedAt createdAt prescription').populate('prescription.productId', 'name isActive');
  let sent = 0;
  for (const note of notes) {
    const due = [];
    note.prescription.forEach((item, index) => {
      if (item.refillReminderSentAt) return;
      const at = refillDueAt(note, item);
      if (at && at.getTime() <= soon && at.getTime() >= now - 14 * 86400000) due.push({ item, index });
    });
    if (!due.length) continue;
    const user = await User.findById(note.userId).select('fullName phone notificationPreferences').lean();
    if (!user) continue;
    const names = due.map(({ item }) => item.medicine).join(', ');
    const orderable = due.some(({ item }) => item.productId && item.productId.isActive !== false);
    const notification = {
      userId: user._id,
      type: 'reminder',
      title: due.length === 1 ? 'Time for a refill' : 'Time for refills',
      message: `${names} ${due.length === 1 ? 'is' : 'are'} about to run out.${orderable ? ' Order again from your prescription for doorstep delivery.' : ' Contact the clinic to refill.'}`,
      relatedId: note._id,
      relatedModel: null,
      priority: 'medium',
      actionUrl: `/prescription/${note._id}`,
      metadata: { kind: 'refill', prescriptionId: String(note._id), medicines: names, productIds: due.map(({ item }) => item.productId?._id).filter(Boolean).map(String) },
    };
    if (allows(user, notification, 'push') || user.notificationPreferences?.prescriptions !== false) {
      await NotificationHelper.create(notification).catch(() => {});
    }
    if (user.phone && allows(user, notification, 'whatsapp')) {
      await whatsapp.sendMessage(user.phone, `Hi ${String(user.fullName || '').split(' ')[0] || 'there'}, ${names} from your Zennara prescription ${due.length === 1 ? 'is' : 'are'} about to run out. ${orderable ? 'Open the Zennara app → My Prescriptions to order again for doorstep delivery.' : 'Reply here or call the clinic to arrange a refill.'}`).catch(() => {});
    }
    due.forEach(({ index }) => { note.prescription[index].refillReminderSentAt = new Date(); });
    note.$locals.skipZenotiWrite = true;
    await note.save({ validateModifiedOnly: true }).catch(() => {});
    sent += 1;
  }
  if (sent) console.log(`💊 Refill reminders sent: ${sent}`);
  return sent;
}
module.exports.sendRefillReminders = sendRefillReminders;

/** 10:00 IST daily — a reminder that arrives at a reasonable hour. */
function startRefillReminderJob() {
  cron.schedule('0 10 * * *', () => { sendRefillReminders().catch((e) => console.error('Refill reminders failed:', e.message)); }, { timezone: 'Asia/Kolkata' });
  console.log('💊 Refill reminder scheduler started - 10:00 IST daily');
}
module.exports.startRefillReminderJob = startRefillReminderJob;
