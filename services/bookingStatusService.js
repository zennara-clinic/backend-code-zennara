const Booking = require('../models/Booking');
const emailService = require('../utils/emailService');
const { bookingScheduledAt, formatClinicDate } = require('../utils/bookingTime');

/**
 * How long after the slot an app booking with no check-in is treated as a no
 * show and the guest is emailed. 15 minutes was aggressive for a clinic where
 * late arrivals are checked in by hand; two hours is the default now, and the
 * desk can always mark a no-show earlier from the panel.
 */
const NO_SHOW_GRACE_MINUTES = Math.max(15, Number(process.env.NO_SHOW_GRACE_MINUTES) || 120);

class BookingStatusService {
  /**
   * Check and update bookings that should be marked as "No Show"
   * This runs automatically to check for appointments that have passed their check-in time
   */
  static async checkAndUpdateNoShowBookings() {
    try {
      console.log('🔍 Checking for No Show bookings...');
      
      const now = new Date();
      
      // Find all confirmed or rescheduled bookings.
      //
      // INCIDENT 2026-09-03: this job used to include appointments mirrored
      // from Zenoti. Front desk check-ins in Zenoti do not always reach us as
      // a checkInTime, so 15 minutes after every clinic appointment this job
      // marked it No Show, and the lifecycle write-back then recorded that no
      // show INSIDE Zenoti ("No show recorded in Zennara") and emailed the
      // guest. Zenoti owns the lifecycle of its own appointments; this job
      // only ever decides for bookings made in the app / reception / package.
      const eligibleBookings = await Booking.find({
        status: { $in: ['Confirmed', 'Rescheduled'] },
        source: { $nin: ['zenoti'] },
        zenotiAppointmentId: null,
        $or: [
          { confirmedDate: { $exists: true } },
          { preferredDate: { $exists: true } }
        ]
      }).populate('consultationId', 'name duration_minutes');

      let updatedCount = 0;

      for (const booking of eligibleBookings) {
        const appointmentDate = booking.confirmedDate || booking.preferredDate;
        const appointmentTime = booking.confirmedTime || booking.preferredTimeSlots[0];
        
        if (!appointmentDate || !appointmentTime) continue;

        // Parse appointment datetime
        const appointmentDateTime = bookingScheduledAt(booking);
        
        if (!appointmentDateTime) continue;

        // Check if appointment time has passed (with 15-minute grace period)
        const gracePeriodMinutes = NO_SHOW_GRACE_MINUTES;
        const cutoffTime = new Date(appointmentDateTime.getTime() + (gracePeriodMinutes * 60 * 1000));
        
        if (now > cutoffTime && !booking.checkInTime) {
          // Mark as No Show — a local decision; it is never pushed to Zenoti.
          booking.status = 'No Show';
          booking.$locals.skipZenotiWrite = true;
          await booking.save();
          
          console.log(`📋 Booking ${booking.referenceNumber} marked as No Show`);
          
          // Send No Show notification email
          try {
            await emailService.sendNoShowNotification(
              booking.email,
              booking.fullName,
              {
                treatment: booking.consultationId?.name || 'Treatment',
                date: formatClinicDate(appointmentDate),
                time: appointmentTime,
                location: booking.preferredLocation,
                referenceNumber: booking.referenceNumber
              },
              booking.preferredLocation
            );
            console.log(`📧 No-show notification sent to ${booking.email}`);
          } catch (emailError) {
            console.error('⚠️ Failed to send no-show email:', emailError.message);
          }
          
          updatedCount++;
        }
      }

      if (updatedCount > 0) {
        console.log(`✅ Updated ${updatedCount} bookings to No Show status`);
      } else {
        console.log('✅ No bookings need to be updated to No Show status');
      }

      return updatedCount;
    } catch (error) {
      console.error('❌ Error checking No Show bookings:', error);
      throw error;
    }
  }

  /**
   * Parse appointment date and time into a single DateTime object
   */
  static parseAppointmentDateTime(date, timeString) {
    return require('../utils/bookingTime').clinicDateTime(date, timeString);
  }

  /**
   * Check if a specific booking should be marked as No Show
   */
  static async checkSingleBookingForNoShow(bookingId) {
    try {
      const booking = await Booking.findById(bookingId).populate('consultationId', 'name');
      
      if (!booking || !['Confirmed', 'Rescheduled'].includes(booking.status)) {
        return false;
      }
      // Zenoti-owned appointments are never auto no-showed here (see above).
      if (booking.source === 'zenoti' || booking.zenotiAppointmentId) return false;

      const now = new Date();
      const appointmentDate = booking.confirmedDate || booking.preferredDate;
      const appointmentTime = booking.confirmedTime || booking.preferredTimeSlots[0];
      
      if (!appointmentDate || !appointmentTime) return false;

      const appointmentDateTime = bookingScheduledAt(booking);
      if (!appointmentDateTime) return false;

      // Check if appointment time has passed (with 15-minute grace period)
      const gracePeriodMinutes = NO_SHOW_GRACE_MINUTES;
      const cutoffTime = new Date(appointmentDateTime.getTime() + (gracePeriodMinutes * 60 * 1000));
      
      if (now > cutoffTime && !booking.checkInTime) {
        booking.status = 'No Show';
        booking.$locals.skipZenotiWrite = true;
        await booking.save();
        
        console.log(`📋 Booking ${booking.referenceNumber} marked as No Show (single check)`);
        
        // Send No Show notification email
        try {
          await emailService.sendNoShowNotification(
            booking.email,
            booking.fullName,
            {
              treatment: booking.consultationId?.name || 'Treatment',
              date: formatClinicDate(appointmentDate),
              time: appointmentTime,
              location: booking.preferredLocation,
              referenceNumber: booking.referenceNumber
            },
            booking.preferredLocation
          );
        } catch (emailError) {
          console.error('⚠️ Failed to send no-show email:', emailError.message);
        }
        
        return true;
      }

      return false;
    } catch (error) {
      console.error('❌ Error checking single booking for No Show:', error);
      return false;
    }
  }

  /**
   * Start the automatic No Show checker (runs every 5 minutes)
   */
  static startAutoChecker() {
    console.log('🚀 Starting automatic No Show checker...');
    
    // Run immediately
    this.checkAndUpdateNoShowBookings();
    
    // Then run every 5 minutes
    setInterval(() => {
      this.checkAndUpdateNoShowBookings();
    }, 5 * 60 * 1000); // 5 minutes
  }
}

module.exports = BookingStatusService;
