const cron = require('node-cron');
const Booking = require('../models/Booking');
const emailService = require('./emailService');

/**
 * Automatically delete expired bookings that are still in "Awaiting Confirmation" status
 * Runs every hour to clean up bookings where the preferred date/time has passed
 */
const cleanupExpiredBookings = async () => {
  try {
    console.log('🧹 Running booking cleanup scheduler...');
    
    const now = new Date();
    const currentDate = now.toISOString().split('T')[0]; // YYYY-MM-DD
    const currentTime = now.toLocaleTimeString('en-US', { 
      hour: '2-digit', 
      minute: '2-digit',
      hour12: true 
    });

    // Find all bookings that are:
    // 1. Still in "Awaiting Confirmation" status
    // 2. Preferred date is in the past OR (date is today AND time has passed)
    const expiredBookings = await Booking.find({
      status: 'Awaiting Confirmation',
      $or: [
        // Date is in the past
        { preferredDate: { $lt: now } },
        // Date is today but we need to check time
        {
          preferredDate: {
            $gte: new Date(currentDate),
            $lt: new Date(new Date(currentDate).setDate(new Date(currentDate).getDate() + 1))
          }
        }
      ]
    }).populate('consultationId', 'name');

    // Filter bookings where time has also passed (for today's bookings)
    const bookingsToDelete = [];
    
    for (const booking of expiredBookings) {
      const bookingDate = booking.preferredDate.toISOString().split('T')[0];
      
      // If booking date is in the past, delete it
      if (bookingDate < currentDate) {
        bookingsToDelete.push(booking);
        continue;
      }
      
      // If booking date is today, check if time has passed
      if (bookingDate === currentDate && booking.preferredTimeSlots.length > 0) {
        const bookingTime = booking.preferredTimeSlots[0]; // e.g., "10:00 AM"
        
        // Compare times
        if (isTimePassed(bookingTime, currentTime)) {
          bookingsToDelete.push(booking);
        }
      }
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
            date: booking.preferredDate.toLocaleDateString('en-US', { 
              weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
            }),
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

/**
 * Helper function to check if a time has passed
 * @param {string} bookingTime - Time in format "10:00 AM"
 * @param {string} currentTime - Current time in format "10:00 AM"
 * @returns {boolean} - True if booking time has passed
 */
function isTimePassed(bookingTime, currentTime) {
  const bookingDate = new Date(`1970-01-01 ${bookingTime}`);
  const currentDate = new Date(`1970-01-01 ${currentTime}`);
  return currentDate > bookingDate;
}

/** "10:00 AM" from a Date; a date with no set time defaults to a 10 AM slot. */
function formatSlotTime(date) {
  const h = date.getHours();
  const m = date.getMinutes();
  if (h === 0 && m === 0) return '10:00 AM';
  const period = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, '0')} ${period}`;
}

/**
 * Auto-create the appointment for each package session ~24 hours before its
 * scheduled date. The booking is free (amount 0, paid), Confirmed, and flagged
 * `isPackageIncluded`, so it appears on the guest's appointment list and runs
 * through the same check-in/out flow. Idempotent: a session with a bookingId is
 * skipped, so re-running never double-books.
 */
const createDuePackageBookings = async () => {
  try {
    const PackageAssignment = require('../models/PackageAssignment');
    const Consultation = require('../models/Consultation');

    const now = new Date();
    const windowEnd = new Date(now.getTime() + 24 * 60 * 60 * 1000);   // book from 24h before
    const windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000); // small catch-up for missed runs

    const assignments = await PackageAssignment.find({
      status: 'Active',
      sessions: {
        $elemMatch: {
          status: 'Scheduled',
          bookingId: null,
          scheduledDate: { $lte: windowEnd, $gte: windowStart }
        }
      }
    }).populate('userId', 'fullName email phone');

    let created = 0;

    for (const assignment of assignments) {
      let touched = false;

      for (const session of assignment.sessions) {
        if (session.status !== 'Scheduled' || session.bookingId) continue;
        if (!session.scheduledDate) continue;
        const when = new Date(session.scheduledDate);
        if (when > windowEnd || when < windowStart) continue;

        if (!assignment.preferredLocation) {
          console.error(`⚠️ Package session ${session._id} has no location on its assignment — skipped`);
          continue;
        }

        // serviceId is a Consultation.id (String); fall back to _id just in case.
        let consultation = await Consultation.findOne({ id: session.serviceId });
        if (!consultation) {
          consultation = await Consultation.findById(session.serviceId).catch(() => null);
        }
        if (!consultation) {
          console.error(`⚠️ Package session ${session._id} — treatment not found: ${session.serviceId}`);
          continue;
        }

        // Prefer the clinic-local label set in the panel; fall back to deriving
        // one from the date so a slot is never blank.
        const timeLabel = session.scheduledTime || formatSlotTime(when);

        try {
          const booking = new Booking({
            userId: assignment.userId?._id || assignment.userId,
            consultationId: consultation._id,
            fullName: assignment.userDetails?.fullName || assignment.userId?.fullName || 'Guest',
            mobileNumber: assignment.userDetails?.phone || assignment.userId?.phone || '',
            email: assignment.userDetails?.email || assignment.userId?.email || '',
            branchId: assignment.branchId || undefined,
            preferredLocation: assignment.preferredLocation,
            preferredDate: when,
            preferredTimeSlots: [timeLabel],
            confirmedDate: when,
            confirmedTime: timeLabel,
            amount: 0,
            paymentStatus: 'paid',
            status: 'Confirmed',
            isPackageIncluded: true,
            packageAssignmentId: assignment._id,
            packageSessionId: session._id
          });
          await booking.save();

          session.bookingId = booking._id;
          session.bookingCreatedAt = new Date();
          session.status = 'Booked';
          touched = true;
          created++;

          try {
            await emailService.sendAppointmentConfirmed(
              booking.email,
              booking.fullName,
              {
                referenceNumber: booking.referenceNumber,
                treatment: consultation.name,
                confirmedDate: when.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
                confirmedTime: timeLabel,
                location: booking.preferredLocation
              },
              booking.preferredLocation
            );
          } catch (e) {
            console.error('⚠️ Package booking email failed:', e.message);
          }
        } catch (e) {
          console.error(`⚠️ Failed to create package booking for session ${session._id}:`, e.message);
        }
      }

      if (touched) {
        await assignment.save().catch((e) => console.error('⚠️ Assignment save failed:', e.message));
      }
    }

    if (created > 0) {
      console.log(`📦 Created ${created} package-session appointment(s)`);
    }
  } catch (error) {
    console.error('❌ Error in package session scheduler:', error);
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

  // Auto-create package-session appointments ~24h before each session's date.
  // Runs every 15 minutes so the appointment appears promptly on the guest's list.
  cron.schedule('*/15 * * * *', () => {
    createDuePackageBookings();
  });

  console.log('📦 Package session scheduler started - runs every 15 minutes');

  // Also run both immediately on server start
  cleanupExpiredBookings();
  createDuePackageBookings();
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
  createDuePackageBookings
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
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(now); dayEnd.setDate(dayEnd.getDate() + 1); dayEnd.setHours(23, 59, 59, 999);
  const candidates = await Booking.find({
    status: { $in: ['Confirmed', 'Rescheduled'] },
    checkInCodeSentAt: null,
    source: { $ne: 'zenoti' },
    $or: [{ confirmedDate: { $gte: dayStart, $lte: dayEnd } }, { confirmedDate: null, preferredDate: { $gte: dayStart, $lte: dayEnd } }],
  }).populate('consultationId', 'name');

  let sent = 0;
  for (const b of candidates) {
    const date = b.confirmedDate || b.preferredDate;
    const time = b.confirmedTime || b.slotTime || (b.preferredTimeSlots && b.preferredTimeSlots[0]);
    if (!date || !time) continue;
    const m = String(time).match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
    if (!m) continue;
    let h = Number(m[1]); const min = Number(m[2]); const mer = (m[3] || '').toLowerCase();
    if (mer === 'pm' && h < 12) h += 12;
    if (mer === 'am' && h === 12) h = 0;
    const start = new Date(date); start.setHours(h, min, 0, 0);
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
