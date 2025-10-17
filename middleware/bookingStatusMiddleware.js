const BookingStatusService = require('../services/bookingStatusService');

/**
 * Middleware to automatically check and update booking status before API responses
 * This ensures real-time status updates when users access booking data
 */
const checkBookingStatus = async (req, res, next) => {
  try {
    // Check if this is a booking-related request
    const isBookingRequest = req.path.includes('/bookings') || req.path.includes('/booking');
    
    if (isBookingRequest) {
      // If requesting a specific booking, check that booking
      if (req.params.id) {
        await BookingStatusService.checkSingleBookingForNoShow(req.params.id);
      }
      // For general booking requests, run a quick check for user's bookings
      else if (req.user && req.user._id) {
        // This could be optimized to only check user's bookings
        // For now, we'll let the scheduled job handle bulk updates
      }
    }
    
    next();
  } catch (error) {
    console.error('❌ Booking status middleware error:', error);
    // Don't block the request if status check fails
    next();
  }
};

module.exports = { checkBookingStatus };
