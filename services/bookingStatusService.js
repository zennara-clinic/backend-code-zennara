const Booking = require('../models/Booking');
const emailService = require('../utils/emailService');

class BookingStatusService {
  /**
   * Check and update bookings that should be marked as "No Show"
   * This runs automatically to check for appointments that have passed their check-in time
   */
  static async checkAndUpdateNoShowBookings() {
    try {
      console.log('🔍 Checking for No Show bookings...');
      
      const now = new Date();
      
      // Find all confirmed or rescheduled bookings
      const eligibleBookings = await Booking.find({
        status: { $in: ['Confirmed', 'Rescheduled'] },
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
        const appointmentDateTime = this.parseAppointmentDateTime(appointmentDate, appointmentTime);
        
        if (!appointmentDateTime) continue;

        // Check if appointment time has passed (with 15-minute grace period)
        const gracePeriodMinutes = 15;
        const cutoffTime = new Date(appointmentDateTime.getTime() + (gracePeriodMinutes * 60 * 1000));
        
        if (now > cutoffTime && !booking.checkInTime) {
          // Mark as No Show
          booking.status = 'No Show';
          await booking.save();
          
          console.log(`📋 Booking ${booking.referenceNumber} marked as No Show`);
          
          // Send No Show notification email
          try {
            await emailService.sendNoShowNotification(
              booking.email,
              booking.fullName,
              {
                treatment: booking.consultationId?.name || 'Treatment',
                date: appointmentDate.toLocaleDateString('en-US', { 
                  weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
                }),
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
    try {
      const appointmentDate = new Date(date);
      
      // Parse time string (e.g., "10:00 AM", "2:30 PM")
      const timeMatch = timeString.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
      if (!timeMatch) {
        console.warn(`Invalid time format: ${timeString}`);
        return null;
      }

      let hours = parseInt(timeMatch[1]);
      const minutes = parseInt(timeMatch[2]);
      const period = timeMatch[3].toUpperCase();

      // Convert to 24-hour format
      if (period === 'PM' && hours !== 12) {
        hours += 12;
      } else if (period === 'AM' && hours === 12) {
        hours = 0;
      }

      appointmentDate.setHours(hours, minutes, 0, 0);
      return appointmentDate;
    } catch (error) {
      console.error('Error parsing appointment datetime:', error);
      return null;
    }
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

      const now = new Date();
      const appointmentDate = booking.confirmedDate || booking.preferredDate;
      const appointmentTime = booking.confirmedTime || booking.preferredTimeSlots[0];
      
      if (!appointmentDate || !appointmentTime) return false;

      const appointmentDateTime = this.parseAppointmentDateTime(appointmentDate, appointmentTime);
      if (!appointmentDateTime) return false;

      // Check if appointment time has passed (with 15-minute grace period)
      const gracePeriodMinutes = 15;
      const cutoffTime = new Date(appointmentDateTime.getTime() + (gracePeriodMinutes * 60 * 1000));
      
      if (now > cutoffTime && !booking.checkInTime) {
        booking.status = 'No Show';
        await booking.save();
        
        console.log(`📋 Booking ${booking.referenceNumber} marked as No Show (single check)`);
        
        // Send No Show notification email
        try {
          await emailService.sendNoShowNotification(
            booking.email,
            booking.fullName,
            {
              treatment: booking.consultationId?.name || 'Treatment',
              date: appointmentDate.toLocaleDateString('en-US', { 
                weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
              }),
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
