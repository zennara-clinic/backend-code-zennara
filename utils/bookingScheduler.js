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
  
  // Also run immediately on server start
  cleanupExpiredBookings();
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
  cleanupExpiredBookings
};
