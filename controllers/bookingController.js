const Booking = require('../models/Booking');
const Consultation = require('../models/Consultation');
const User = require('../models/User');
const Branch = require('../models/Branch');
const emailService = require('../utils/emailService');
const NotificationHelper = require('../utils/notificationHelper');
const whatsappService = require('../services/whatsappService');
const twilioVoiceService = require('../services/twilioVoiceService');

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
      preferredTimeSlot
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
      preferredTimeSlot,
      status: 'Awaiting Confirmation'
    });

    console.log('💾 Attempting to save booking with userId:', req.user._id);
    await booking.save();
    console.log('✅ Booking saved successfully with reference:', booking.referenceNumber);

    // Populate consultation details
    await booking.populate('consultationId', 'name category price image');

    // Create notification for admin and user
    try {
      await NotificationHelper.bookingCreated({
        _id: booking._id,
        userId: booking.userId,
        patientName: booking.fullName,
        consultation: { name: consultation.name },
        branch: { name: branch.name },
        appointmentDate: booking.preferredDate
      });
      console.log('🔔 Booking notification created');
    } catch (notifError) {
      console.error('⚠️ Failed to create notification:', notifError.message);
    }

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
          timeSlot: booking.preferredTimeSlot,
          location: booking.preferredLocation
        },
        booking.preferredLocation
      );
      console.log('📧 Booking confirmation email sent');
    } catch (emailError) {
      console.error('⚠️ Email sending failed, but booking was created:', emailError.message);
    }

    // Send WhatsApp booking confirmation
    try {
      await whatsappService.sendBookingConfirmation(
        booking.mobileNumber,
        {
          patientName: booking.fullName,
          referenceNumber: booking.referenceNumber,
          treatment: consultation.name,
          date: booking.preferredDate.toLocaleDateString('en-US', { 
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
          }),
          timeSlot: booking.preferredTimeSlot,
          location: booking.preferredLocation
        }
      );
      console.log('WhatsApp booking confirmation sent');
    } catch (whatsappError) {
      console.error('WhatsApp sending failed, but booking was created:', whatsappError.message);
    }

    // Make automated voice call for booking confirmation
    try {
      const formattedDate = booking.preferredDate.toLocaleDateString('en-US', { 
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
      });
      
      await twilioVoiceService.makeBookingConfirmationCall(
        booking.mobileNumber,
        {
          patientName: booking.fullName,
          referenceNumber: booking.referenceNumber,
          treatment: consultation.name,
          date: formattedDate,
          timeSlot: booking.preferredTimeSlot,
          branchName: branch.name,
          branchAddress: branch.address.line1 + ', ' + branch.address.city
        }
      );
      console.log('Voice call initiated for booking confirmation');
    } catch (voiceError) {
      console.error('Voice call failed, but booking was created:', voiceError.message);
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

    // Create cancellation notification
    try {
      await NotificationHelper.bookingCancelled({
        _id: booking._id,
        userId: booking.userId,
        consultation: { name: booking.consultationId.name },
        cancellationReason: reason
      });
      console.log('🔔 Booking cancellation notification created');
    } catch (notifError) {
      console.error('⚠️ Failed to create notification:', notifError.message);
    }

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
          time: booking.preferredTimeSlot,
          location: booking.preferredLocation
        },
        booking.preferredLocation
      );
      console.log('📧 Cancellation email sent');
    } catch (emailError) {
      console.error('⚠️ Email sending failed:', emailError.message);
    }

    // Send WhatsApp cancellation notification
    try {
      await whatsappService.sendAppointmentCancelled(
        booking.mobileNumber,
        {
          patientName: booking.fullName,
          referenceNumber: booking.referenceNumber,
          treatment: booking.consultationId.name,
          date: booking.preferredDate.toLocaleDateString('en-US', { 
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
          }),
          time: booking.preferredTimeSlot,
          location: booking.preferredLocation,
          reason: reason
        }
      );
      console.log('WhatsApp cancellation notification sent');
    } catch (whatsappError) {
      console.error('WhatsApp sending failed:', whatsappError.message);
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
    const oldTime = booking.preferredTimeSlot;

    booking.rescheduledFrom = {
      date: booking.preferredDate,
      time: oldTime
    };

    booking.preferredDate = new Date(newDate);
    booking.preferredTimeSlot = newTimeSlot;
    
    // Update confirmed date and time to the new rescheduled values
    booking.confirmedDate = new Date(newDate);
    booking.confirmedTime = newTimeSlot;
    
    booking.status = 'Rescheduled';
    booking.rescheduledAt = new Date();

    await booking.save();

    // Populate consultation details for email
    await booking.populate('consultationId', 'name');

    // Create notification for reschedule
    try {
      await NotificationHelper.bookingRescheduled({
        _id: booking._id,
        userId: booking.userId,
        patientName: booking.fullName,
        consultation: { name: booking.consultationId.name },
        confirmedDate: booking.confirmedDate,
        confirmedTime: booking.confirmedTime
      });
      console.log('🔔 Booking reschedule notification created');
    } catch (notifError) {
      console.error('⚠️ Failed to create notification:', notifError.message);
    }

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
          newTime: booking.preferredTimeSlot,
          location: booking.preferredLocation
        },
        booking.preferredLocation
      );
      console.log('📧 Reschedule email sent');
    } catch (emailError) {
      console.error('⚠️ Email sending failed:', emailError.message);
    }

    // Send WhatsApp rescheduled notification
    try {
      await whatsappService.sendAppointmentRescheduled(
        booking.mobileNumber,
        {
          patientName: booking.fullName,
          referenceNumber: booking.referenceNumber,
          treatment: booking.consultationId.name,
          oldDate: oldDate,
          oldTime: oldTime,
          newDate: booking.preferredDate.toLocaleDateString('en-US', { 
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
          }),
          newTime: booking.preferredTimeSlot,
          location: booking.preferredLocation
        }
      );
      console.log('WhatsApp reschedule notification sent');
    } catch (whatsappError) {
      console.error('WhatsApp sending failed:', whatsappError.message);
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

    // Create notification for check-in
    try {
      await NotificationHelper.bookingCheckedIn({
        _id: booking._id,
        patientName: booking.fullName,
        consultation: { name: booking.consultationId.name },
        checkInTime: booking.checkInTime
      });
      console.log('🔔 Booking check-in notification created');
    } catch (notifError) {
      console.error('⚠️ Failed to create notification:', notifError.message);
    }

    // Send check-in email
    try {
      await emailService.sendCheckInSuccessful(
        booking.email,
        booking.fullName,
        {
          treatment: booking.consultationId.name,
          time: booking.preferredTimeSlot,
          location: booking.preferredLocation,
          waitTime: '5-10' // You can make this dynamic based on queue
        },
        booking.preferredLocation
      );
      console.log('📧 Check-in email sent');
    } catch (emailError) {
      console.error('⚠️ Email sending failed:', emailError.message);
    }

    // Send WhatsApp check-in notification
    try {
      await whatsappService.sendCheckInSuccessful(
        booking.mobileNumber,
        {
          patientName: booking.fullName,
          treatment: booking.consultationId.name,
          time: booking.preferredTimeSlot,
          location: booking.preferredLocation,
          waitTime: '5-10'
        }
      );
      console.log('WhatsApp check-in notification sent');
    } catch (whatsappError) {
      console.error('WhatsApp sending failed:', whatsappError.message);
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

    // Create notification for completion
    try {
      await NotificationHelper.bookingCompleted({
        _id: booking._id,
        userId: booking.userId,
        patientName: booking.fullName,
        consultation: { name: booking.consultationId.name },
        checkOutTime: booking.checkOutTime,
        sessionDuration: booking.sessionDuration
      });
      console.log('🔔 Booking completion notification created');
    } catch (notifError) {
      console.error('⚠️ Failed to create notification:', notifError.message);
    }

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
          time: booking.preferredTimeSlot,
          location: booking.preferredLocation
        },
        booking.preferredLocation
      );
      console.log('📧 Appointment completed email sent');
    } catch (emailError) {
      console.error('⚠️ Email sending failed:', emailError.message);
    }

    // Send WhatsApp completion notification
    try {
      await whatsappService.sendAppointmentCompleted(
        booking.mobileNumber,
        {
          patientName: booking.fullName,
          treatment: booking.consultationId.name,
          date: booking.preferredDate.toLocaleDateString('en-US', { 
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
          }),
          location: booking.preferredLocation,
          sessionDuration: booking.sessionDuration,
          bookingId: booking._id
        }
      );
      console.log('WhatsApp completion notification sent');
    } catch (whatsappError) {
      console.error('WhatsApp sending failed:', whatsappError.message);
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
    booking.status = 'Completed';
    booking.checkOutTime = new Date();

    await booking.save();

    res.status(200).json({
      success: true,
      message: 'Rating submitted successfully',
      data: booking
    });
  } catch (error) {
    console.error('❌ Rating submission error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to submit rating'
    });
  }
};

// @desc    Get all bookings (Admin)
// @route   GET /api/bookings/admin/all
// @access  Private (Admin)
exports.getAllBookingsAdmin = async (req, res) => {
  try {
    const { status, location, date, search } = req.query;

    // Build query
    const query = {};

    if (status && status !== 'all') {
      query.status = status;
    }

    if (location && location !== 'all') {
      query.preferredLocation = location;
    }

    if (date) {
      const startDate = new Date(date);
      startDate.setHours(0, 0, 0, 0);
      const endDate = new Date(date);
      endDate.setHours(23, 59, 59, 999);
      query.preferredDate = { $gte: startDate, $lte: endDate };
    }

    if (search) {
      query.$or = [
        { fullName: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { mobileNumber: { $regex: search, $options: 'i' } },
        { referenceNumber: { $regex: search, $options: 'i' } }
      ];
    }

    const bookings = await Booking.find(query)
      .populate('consultationId', 'name category price image')
      .populate('userId', 'fullName email phone patientId')
      .populate('branchId', 'name address')
      .sort({ createdAt: -1 })
      .select('-__v');

    res.status(200).json({
      success: true,
      count: bookings.length,
      data: bookings
    });
  } catch (error) {
    console.error('❌ Get all bookings admin error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch bookings'
    });
  }
};

// @desc    Confirm booking (Admin)
// @route   PUT /api/bookings/admin/:id/confirm
// @access  Private (Admin)
exports.confirmBooking = async (req, res) => {
  try {
    const { confirmedDate, confirmedTime } = req.body;

    const booking = await Booking.findById(req.params.id);

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    if (booking.status !== 'Awaiting Confirmation' && booking.status !== 'Rescheduled') {
      return res.status(400).json({
        success: false,
        message: 'Only awaiting or rescheduled bookings can be confirmed'
      });
    }

    booking.status = 'Confirmed';
    booking.confirmedDate = new Date(confirmedDate);
    booking.confirmedTime = confirmedTime;

    await booking.save();

    // Populate consultation details for email
    await booking.populate('consultationId', 'name');

    // Create notification for user
    try {
      await NotificationHelper.bookingConfirmed({
        _id: booking._id,
        userId: booking.userId,
        patientName: booking.fullName,
        consultation: { name: booking.consultationId.name },
        confirmedDate: booking.confirmedDate,
        confirmedTime: booking.confirmedTime
      });
      console.log('🔔 Booking confirmation notification created');
    } catch (notifError) {
      console.error('⚠️ Failed to create notification:', notifError.message);
    }

    // Send confirmation email
    try {
      await emailService.sendAppointmentConfirmed(
        booking.email,
        booking.fullName,
        {
          referenceNumber: booking.referenceNumber,
          treatment: booking.consultationId.name,
          confirmedDate: booking.confirmedDate.toLocaleDateString('en-US', { 
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
          }),
          confirmedTime: booking.confirmedTime,
          location: booking.preferredLocation,
          address: 'Clinic Address' // You can get this from branchId
        },
        booking.preferredLocation
      );
      console.log('📧 Confirmation email sent');
    } catch (emailError) {
      console.error('⚠️ Email sending failed:', emailError.message);
    }

    // Send WhatsApp confirmation notification
    try {
      await whatsappService.sendAppointmentConfirmed(
        booking.mobileNumber,
        {
          patientName: booking.fullName,
          referenceNumber: booking.referenceNumber,
          treatment: booking.consultationId.name,
          confirmedDate: booking.confirmedDate.toLocaleDateString('en-US', { 
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
          }),
          confirmedTime: booking.confirmedTime,
          location: booking.preferredLocation,
          address: 'Clinic Address' // You can get this from branchId
        }
      );
      console.log('WhatsApp confirmation notification sent');
    } catch (whatsappError) {
      console.error('WhatsApp sending failed:', whatsappError.message);
    }

    res.status(200).json({
      success: true,
      message: 'Booking confirmed successfully',
      data: booking
    });
  } catch (error) {
    console.error('❌ Confirm booking error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to confirm booking'
    });
  }
};

// @desc    Mark booking as No Show (Admin)
// @route   PUT /api/bookings/admin/:id/no-show
// @access  Private (Admin)
exports.markNoShow = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    if (booking.status !== 'Confirmed' && booking.status !== 'Rescheduled') {
      return res.status(400).json({
        success: false,
        message: 'Only confirmed bookings can be marked as no-show'
      });
    }

    booking.status = 'No Show';
    await booking.save();

    // Populate consultation details for email
    await booking.populate('consultationId', 'name');

    // Create notification for no-show
    try {
      await NotificationHelper.bookingNoShow({
        _id: booking._id,
        patientName: booking.fullName,
        consultation: { name: booking.consultationId.name },
        confirmedDate: booking.confirmedDate,
        confirmedTime: booking.confirmedTime
      });
      console.log('🔔 No-show notification created');
    } catch (notifError) {
      console.error('⚠️ Failed to create notification:', notifError.message);
    }

    // Send no-show notification email
    try {
      await emailService.sendNoShowNotification(
        booking.email,
        booking.fullName,
        {
          treatment: booking.consultationId.name,
          date: booking.confirmedDate?.toLocaleDateString('en-US', { 
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
          }) || booking.preferredDate.toLocaleDateString('en-US', { 
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
          }),
          time: booking.confirmedTime || booking.preferredTimeSlots[0],
          location: booking.preferredLocation
        },
        booking.preferredLocation
      );
      console.log('📧 No-show notification email sent');
    } catch (emailError) {
      console.error('⚠️ Email sending failed:', emailError.message);
    }

    // Send WhatsApp no-show notification
    try {
      await whatsappService.sendNoShowNotification(
        booking.mobileNumber,
        {
          patientName: booking.fullName,
          treatment: booking.consultationId.name,
          date: booking.confirmedDate?.toLocaleDateString('en-US', { 
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
          }) || booking.preferredDate.toLocaleDateString('en-US', { 
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
          }),
          time: booking.confirmedTime || booking.preferredTimeSlots[0],
          location: booking.preferredLocation
        }
      );
      console.log('WhatsApp no-show notification sent');
    } catch (whatsappError) {
      console.error('WhatsApp sending failed:', whatsappError.message);
    }

    res.status(200).json({
      success: true,
      message: 'Booking marked as no-show',
      data: booking
    });
  } catch (error) {
    console.error('❌ Mark no-show error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to mark as no-show'
    });
  }
};

// @desc    Get booking by ID (Admin)
// @route   GET /api/bookings/admin/:id
// @access  Private (Admin)
exports.getBookingByIdAdmin = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id)
      .populate('consultationId', 'name category price image duration_minutes')
      .populate('userId', 'name email patientId');

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
    console.error('❌ Get booking by ID admin error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch booking'
    });
  }
};

// @desc    Check-in booking (Admin)
// @route   PUT /api/bookings/admin/:id/checkin
// @access  Private (Admin)
exports.checkInBookingAdmin = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);

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

    // Create notification for check-in (admin endpoint)
    try {
      await NotificationHelper.bookingCheckedIn({
        _id: booking._id,
        patientName: booking.fullName,
        consultation: { name: booking.consultationId.name },
        checkInTime: booking.checkInTime
      });
      console.log('🔔 Booking check-in notification created');
    } catch (notifError) {
      console.error('⚠️ Failed to create notification:', notifError.message);
    }

    // Send check-in email
    try {
      await emailService.sendCheckInSuccessful(
        booking.email,
        booking.fullName,
        {
          treatment: booking.consultationId.name,
          time: booking.confirmedTime || booking.preferredTimeSlots[0],
          location: booking.preferredLocation,
          waitTime: '5-10'
        },
        booking.preferredLocation
      );
      console.log('📧 Check-in email sent');
    } catch (emailError) {
      console.error('⚠️ Email sending failed:', emailError.message);
    }

    // Send WhatsApp check-in notification (admin)
    try {
      await whatsappService.sendCheckInSuccessful(
        booking.mobileNumber,
        {
          patientName: booking.fullName,
          treatment: booking.consultationId.name,
          time: booking.confirmedTime || booking.preferredTimeSlots[0],
          location: booking.preferredLocation,
          waitTime: '5-10'
        }
      );
      console.log('WhatsApp check-in notification sent');
    } catch (whatsappError) {
      console.error('WhatsApp sending failed:', whatsappError.message);
    }

    res.status(200).json({
      success: true,
      message: 'Patient checked in successfully',
      data: booking
    });
  } catch (error) {
    console.error('❌ Check-in booking admin error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check in booking'
    });
  }
};

// @desc    Check-out booking (Admin)
// @route   PUT /api/bookings/admin/:id/checkout
// @access  Private (Admin)
exports.checkOutBookingAdmin = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);

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

    await booking.save();

    // Populate consultation details
    await booking.populate('consultationId', 'name');

    // Create notification for completion (admin endpoint)
    try {
      await NotificationHelper.bookingCompleted({
        _id: booking._id,
        userId: booking.userId,
        patientName: booking.fullName,
        consultation: { name: booking.consultationId.name },
        checkOutTime: booking.checkOutTime
      });
      console.log('🔔 Booking completion notification created');
    } catch (notifError) {
      console.error('⚠️ Failed to create notification:', notifError.message);
    }

    // Send completion email
    try {
      await emailService.sendAppointmentCompleted(
        booking.email,
        booking.fullName,
        {
          treatment: booking.consultationId.name,
          date: booking.confirmedDate?.toLocaleDateString('en-US', { 
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
          }) || booking.preferredDate.toLocaleDateString('en-US', { 
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
          }),
          location: booking.preferredLocation
        },
        booking.preferredLocation
      );
      console.log('📧 Completion email sent');
    } catch (emailError) {
      console.error('⚠️ Email sending failed:', emailError.message);
    }

    // Send WhatsApp completion notification (admin)
    try {
      await whatsappService.sendAppointmentCompleted(
        booking.mobileNumber,
        {
          patientName: booking.fullName,
          treatment: booking.consultationId.name,
          date: booking.confirmedDate?.toLocaleDateString('en-US', { 
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
          }) || booking.preferredDate.toLocaleDateString('en-US', { 
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
          }),
          location: booking.preferredLocation,
          sessionDuration: booking.sessionDuration,
          bookingId: booking._id
        }
      );
      console.log('WhatsApp completion notification sent');
    } catch (whatsappError) {
      console.error('WhatsApp sending failed:', whatsappError.message);
    }

    res.status(200).json({
      success: true,
      message: 'Booking completed successfully',
      data: booking
    });
  } catch (error) {
    console.error('❌ Check-out booking admin error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check out booking'
    });
  }
};

// @desc    Cancel booking (Admin)
// @route   PUT /api/bookings/admin/:id/cancel
// @access  Private (Admin)
exports.cancelBookingAdmin = async (req, res) => {
  try {
    const { reason } = req.body;

    const booking = await Booking.findById(req.params.id);

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    // Admin can cancel Confirmed or Rescheduled bookings
    if (!['Confirmed', 'Rescheduled'].includes(booking.status)) {
      return res.status(400).json({
        success: false,
        message: 'Only confirmed or rescheduled bookings can be cancelled'
      });
    }

    booking.status = 'Cancelled';
    booking.cancellationReason = reason || 'Cancelled by admin';
    booking.cancelledAt = new Date();
    booking.cancelledBy = 'admin';

    await booking.save();

    // Populate consultation details for email
    await booking.populate('consultationId', 'name');

    // Create cancellation notification for user
    try {
      await NotificationHelper.bookingCancelled({
        _id: booking._id,
        userId: booking.userId,
        consultation: { name: booking.consultationId.name },
        cancellationReason: reason || 'Cancelled by admin'
      });
      console.log('🔔 Booking cancellation notification created by admin');
    } catch (notifError) {
      console.error('⚠️ Failed to create notification:', notifError.message);
    }

    // Send cancellation email
    try {
      await emailService.sendAppointmentCancelled(
        booking.email,
        booking.fullName,
        {
          referenceNumber: booking.referenceNumber,
          treatment: booking.consultationId.name,
          date: (booking.confirmedDate || booking.preferredDate).toLocaleDateString('en-US', { 
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
          }),
          time: booking.confirmedTime || booking.preferredTimeSlots[0],
          location: booking.preferredLocation
        },
        booking.preferredLocation
      );
      console.log('📧 Cancellation email sent by admin');
    } catch (emailError) {
      console.error('⚠️ Email sending failed:', emailError.message);
    }

    // Send WhatsApp cancellation notification (admin)
    try {
      await whatsappService.sendAppointmentCancelled(
        booking.mobileNumber,
        {
          patientName: booking.fullName,
          referenceNumber: booking.referenceNumber,
          treatment: booking.consultationId.name,
          date: (booking.confirmedDate || booking.preferredDate).toLocaleDateString('en-US', { 
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' 
          }),
          time: booking.confirmedTime || booking.preferredTimeSlots[0],
          location: booking.preferredLocation,
          reason: reason || 'Cancelled by admin'
        }
      );
      console.log('WhatsApp cancellation notification sent by admin');
    } catch (whatsappError) {
      console.error('WhatsApp sending failed:', whatsappError.message);
    }

    res.status(200).json({
      success: true,
      message: 'Booking cancelled successfully',
      data: booking
    });
  } catch (error) {
    console.error('❌ Cancel booking admin error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to cancel booking'
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
        bookedSlots.push(booking.preferredTimeSlot);
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
