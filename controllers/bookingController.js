const Booking = require('../models/Booking');
const Consultation = require('../models/Consultation');
const User = require('../models/User');
const Branch = require('../models/Branch');
const emailService = require('../utils/emailService');

// @desc    Create new booking
// @route   POST /api/bookings
// @access  Private
exports.createBooking = async (req, res) => {
  try {
    console.log('🔍 User from auth middleware:', req.user);
    
    const {
      consultationId,
      fullName,
      mobileNumber,
      email,
      preferredLocation,
      preferredDate,
      preferredTimeSlots
    } = req.body;

    // Validate consultation exists
    const consultation = await Consultation.findById(consultationId);
    if (!consultation) {
      return res.status(404).json({
        success: false,
        message: 'Consultation not found'
      });
    }

    // Find branch by name
    const branch = await Branch.findOne({ name: preferredLocation, isActive: true });
    if (!branch) {
      return res.status(404).json({
        success: false,
        message: 'Branch not found or inactive'
      });
    }

    // Create booking with pre-save hook for reference number
    const booking = new Booking({
      userId: req.user._id,
      consultationId,
      fullName,
      mobileNumber,
      email,
      branchId: branch._id,
      preferredLocation,
      preferredDate: new Date(preferredDate),
      preferredTimeSlots,
      status: 'Awaiting Confirmation'
    });

    console.log('💾 Attempting to save booking with userId:', req.user._id);
    await booking.save();
    console.log('✅ Booking saved successfully with reference:', booking.referenceNumber);

    // Populate consultation details
    await booking.populate('consultationId', 'name category price image');

    // Send booking confirmation email
    try {
      await emailService.sendAppointmentBookingConfirmation(
        booking.email,
        booking.fullName,
        {
          referenceNumber: booking.referenceNumber,
          treatment: consultation.name,
          category: consultation.category,
          preferredDate: booking.preferredDate.toLocaleDateString('en-US', { 
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
          }),
          timeSlots: booking.preferredTimeSlots.join(', '),
          location: booking.preferredLocation
        },
        booking.preferredLocation
      );
      console.log('📧 Booking confirmation email sent');
    } catch (emailError) {
      console.error('⚠️ Email sending failed, but booking was created:', emailError.message);
    }

    res.status(201).json({
      success: true,
      message: 'Booking created successfully',
      data: booking
    });
  } catch (error) {
    console.error('❌ Create booking error:', error);
    console.error('❌ Error details:', error.message);
    console.error('❌ Error stack:', error.stack);
    
    // Handle validation errors
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors
      });
    }
    
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to create booking'
    });
  }
};

// @desc    Get all bookings for user
// @route   GET /api/bookings
// @access  Private
exports.getUserBookings = async (req, res) => {
  try {
    const { status, upcoming } = req.query;

    // Build query
    const query = { userId: req.user._id };

    if (status) {
      query.status = status;
    }

    // Filter upcoming or past bookings
    if (upcoming === 'true') {
      query.status = {
        $in: ['Awaiting Confirmation', 'Confirmed', 'Rescheduled', 'In Progress']
      };
    } else if (upcoming === 'false') {
      query.status = {
        $in: ['Cancelled', 'No Show', 'Completed']
      };
    }

    const bookings = await Booking.find(query)
      .populate('consultationId', 'name category price image duration_minutes')
      .sort({ createdAt: -1 })
      .select('-__v');

    res.status(200).json({
      success: true,
      count: bookings.length,
      data: bookings
    });
  } catch (error) {
    console.error('❌ Get bookings error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch bookings'
    });
  }
};

// @desc    Get single booking
// @route   GET /api/bookings/:id
// @access  Private
exports.getBooking = async (req, res) => {
  try {
    const booking = await Booking.findOne({
      _id: req.params.id,
      userId: req.user._id
    }).populate('consultationId', 'name category price image duration_minutes');

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    res.status(200).json({
      success: true,
      data: booking
    });
  } catch (error) {
    console.error('❌ Get booking error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch booking'
    });
  }
};

// @desc    Get booking by reference number
// @route   GET /api/bookings/reference/:referenceNumber
// @access  Private
exports.getBookingByReference = async (req, res) => {
  try {
    const booking = await Booking.findOne({
      referenceNumber: req.params.referenceNumber,
      userId: req.user._id
    }).populate('consultationId', 'name category price image duration_minutes');

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    res.status(200).json({
      success: true,
      data: booking
    });
  } catch (error) {
    console.error('❌ Get booking by reference error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch booking'
    });
  }
};

// @desc    Cancel booking
// @route   PUT /api/bookings/:id/cancel
// @access  Private
exports.cancelBooking = async (req, res) => {
  try {
    const { reason } = req.body;

    const booking = await Booking.findOne({
      _id: req.params.id,
      userId: req.user._id
    });

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    if (!booking.canBeCancelled()) {
      return res.status(400).json({
        success: false,
        message: 'Booking cannot be cancelled at this stage'
      });
    }

    booking.status = 'Cancelled';
    booking.cancellationReason = reason;
    booking.cancelledAt = new Date();

    await booking.save();

    // Populate consultation details for email
    await booking.populate('consultationId', 'name');

    // Send cancellation email
    try {
      await emailService.sendAppointmentCancelled(
        booking.email,
        booking.fullName,
        {
          referenceNumber: booking.referenceNumber,
          treatment: booking.consultationId.name,
          date: booking.preferredDate.toLocaleDateString('en-US', { 
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
          }),
          time: booking.preferredTimeSlots[0],
          location: booking.preferredLocation
        },
        booking.preferredLocation
      );
      console.log('📧 Cancellation email sent');
    } catch (emailError) {
      console.error('⚠️ Email sending failed:', emailError.message);
    }

    res.status(200).json({
      success: true,
      message: 'Booking cancelled successfully',
      data: booking
    });
  } catch (error) {
    console.error('❌ Cancel booking error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to cancel booking'
    });
  }
};

// @desc    Reschedule booking
// @route   PUT /api/bookings/:id/reschedule
// @access  Private
exports.rescheduleBooking = async (req, res) => {
  try {
    const { newDate, newTimeSlots } = req.body;

    const booking = await Booking.findOne({
      _id: req.params.id,
      userId: req.user._id
    });

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    if (!booking.canBeRescheduled()) {
      return res.status(400).json({
        success: false,
        message: 'Booking cannot be rescheduled at this stage'
      });
    }

    // Store old date/time
    const oldDate = booking.preferredDate.toLocaleDateString('en-US', { 
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
    });
    const oldTime = booking.preferredTimeSlots[0];

    booking.rescheduledFrom = {
      date: booking.preferredDate,
      time: oldTime
    };

    booking.preferredDate = new Date(newDate);
    booking.preferredTimeSlots = newTimeSlots;
    booking.status = 'Rescheduled';
    booking.rescheduledAt = new Date();

    await booking.save();

    // Populate consultation details for email
    await booking.populate('consultationId', 'name');

    // Send rescheduled email
    try {
      await emailService.sendAppointmentRescheduled(
        booking.email,
        booking.fullName,
        {
          referenceNumber: booking.referenceNumber,
          treatment: booking.consultationId.name,
          oldDate: oldDate,
          oldTime: oldTime,
          newDate: booking.preferredDate.toLocaleDateString('en-US', { 
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
          }),
          newTime: booking.preferredTimeSlots[0],
          location: booking.preferredLocation
        },
        booking.preferredLocation
      );
      console.log('📧 Reschedule email sent');
    } catch (emailError) {
      console.error('⚠️ Email sending failed:', emailError.message);
    }

    res.status(200).json({
      success: true,
      message: 'Booking rescheduled successfully',
      data: booking
    });
  } catch (error) {
    console.error('❌ Reschedule booking error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to reschedule booking'
    });
  }
};

// @desc    Check-in booking
// @route   PUT /api/bookings/:id/checkin
// @access  Private
exports.checkInBooking = async (req, res) => {
  try {
    const booking = await Booking.findOne({
      _id: req.params.id,
      userId: req.user._id
    });

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    if (!['Confirmed', 'Rescheduled'].includes(booking.status)) {
      return res.status(400).json({
        success: false,
        message: 'Only confirmed bookings can be checked in'
      });
    }

    booking.status = 'In Progress';
    booking.checkInTime = new Date();

    await booking.save();

    // Populate consultation details for email
    await booking.populate('consultationId', 'name');

    // Send check-in email
    try {
      await emailService.sendCheckInSuccessful(
        booking.email,
        booking.fullName,
        {
          treatment: booking.consultationId.name,
          time: booking.preferredTimeSlots[0],
          location: booking.preferredLocation,
          waitTime: '5-10' // You can make this dynamic based on queue
        },
        booking.preferredLocation
      );
      console.log('📧 Check-in email sent');
    } catch (emailError) {
      console.error('⚠️ Email sending failed:', emailError.message);
    }

    res.status(200).json({
      success: true,
      message: 'Checked in successfully',
      data: booking
    });
  } catch (error) {
    console.error('❌ Check-in booking error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check in'
    });
  }
};

// @desc    Check-out booking (Complete)
// @route   PUT /api/bookings/:id/checkout
// @access  Private
exports.checkOutBooking = async (req, res) => {
  try {
    const booking = await Booking.findOne({
      _id: req.params.id,
      userId: req.user._id
    });

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    if (booking.status !== 'In Progress') {
      return res.status(400).json({
        success: false,
        message: 'Only in-progress bookings can be checked out'
      });
    }

    booking.status = 'Completed';
    booking.checkOutTime = new Date();

    // Calculate session duration
    if (booking.checkInTime) {
      const duration = (booking.checkOutTime - booking.checkInTime) / 1000 / 60; // minutes
      booking.sessionDuration = Math.round(duration);
    }

    await booking.save();

    // Populate consultation details for email
    await booking.populate('consultationId', 'name');

    // Send appointment completed email
    try {
      await emailService.sendAppointmentCompleted(
        booking.email,
        booking.fullName,
        {
          treatment: booking.consultationId.name,
          date: booking.preferredDate.toLocaleDateString('en-US', { 
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
          }),
          time: booking.preferredTimeSlots[0],
          location: booking.preferredLocation
        },
        booking.preferredLocation
      );
      console.log('📧 Appointment completed email sent');
    } catch (emailError) {
      console.error('⚠️ Email sending failed:', emailError.message);
    }

    res.status(200).json({
      success: true,
      message: 'Checked out successfully',
      data: booking
    });
  } catch (error) {
    console.error('❌ Check-out booking error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check out'
    });
  }
};

// @desc    Rate booking
// @route   PUT /api/bookings/:id/rate
// @access  Private
exports.rateBooking = async (req, res) => {
  try {
    const { rating, feedback } = req.body;

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({
        success: false,
        message: 'Rating must be between 1 and 5'
      });
    }

    const booking = await Booking.findOne({
      _id: req.params.id,
      userId: req.user._id
    });

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    if (booking.status !== 'Completed') {
      return res.status(400).json({
        success: false,
        message: 'Only completed bookings can be rated'
      });
    }

    booking.rating = rating;
    booking.feedback = feedback;
    booking.ratedAt = new Date();

    await booking.save();

    res.status(200).json({
      success: true,
      message: 'Rating submitted successfully',
      data: booking
    });
  } catch (error) {
    console.error('❌ Rate booking error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to submit rating'
    });
  }
};

// @desc    Get available time slots for a date and location
// @route   GET /api/bookings/available-slots
// @access  Public
exports.getAvailableTimeSlots = async (req, res) => {
  try {
    const { date, location } = req.query;

    if (!date || !location) {
      return res.status(400).json({
        success: false,
        message: 'Date and location are required'
      });
    }

    // All available time slots (10 AM to 7 PM)
    const allSlots = [
      '10:00 AM', '11:00 AM', '12:00 PM',
      '1:00 PM', '2:00 PM', '3:00 PM',
      '4:00 PM', '5:00 PM', '6:00 PM', '7:00 PM'
    ];

    // Get bookings for the date and location
    const startDate = new Date(date);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(date);
    endDate.setHours(23, 59, 59, 999);

    const bookings = await Booking.find({
      preferredLocation: location,
      preferredDate: { $gte: startDate, $lte: endDate },
      status: { $in: ['Awaiting Confirmation', 'Confirmed', 'Rescheduled'] }
    });

    // Get booked slots
    const bookedSlots = [];
    bookings.forEach(booking => {
      booking.preferredTimeSlots.forEach(slot => {
        bookedSlots.push(slot);
      });
    });

    // Filter available slots
    const availableSlots = allSlots.filter(slot => !bookedSlots.includes(slot));

    res.status(200).json({
      success: true,
      data: {
        date,
        location,
        availableSlots,
        bookedSlots
      }
    });
  } catch (error) {
    console.error('❌ Get available slots error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch available slots'
    });
  }
};
