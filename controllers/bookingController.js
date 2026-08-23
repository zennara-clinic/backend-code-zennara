const Booking = require('../models/Booking');
const Consultation = require('../models/Consultation');
const User = require('../models/User');
const Branch = require('../models/Branch');
const emailService = require('../utils/emailService');
const NotificationHelper = require('../utils/notificationHelper');
const whatsappService = require('../services/whatsappService');
const twilioVoiceService = require('../services/twilioVoiceService');
const { bookingScheduledAt } = require('../utils/bookingTime');
const { validateBranchBooking } = require('../utils/branchSchedule');
const { SESSION_SLOT_MINUTES } = require('../config/scheduling');

// @desc    Create new booking
// @route   POST /api/bookings
// @access  Private

/**
 * Fold the therapist's session summary (structured `session` and/or a free
 * `notes` string) into the booking at checkout.
 */
function applySessionFromBody(booking, req) {
  const body = req.body || {};
  if (body.session && typeof body.session === 'object') {
    const sess = body.session;
    booking.session = {
      items: Array.isArray(sess.items) ? sess.items : [],
      wastage: Array.isArray(sess.wastage) ? sess.wastage : [],
      serviceFee: Number(sess.serviceFee) || 0,
      productTotal: Number(sess.productTotal) || 0,
      discount: Number(sess.discount) || 0,
      total: Number(sess.total) || 0,
      grading: sess.grading || '',
      notes: sess.notes || '',
      therapist: sess.therapist || req.admin?.name || '',
      completedAt: new Date(),
    };
    if (!booking.therapistName && booking.session.therapist) booking.therapistName = booking.session.therapist;
    if (!booking.therapistId && req.admin?.role === 'therapist') booking.therapistId = req.admin._id;
  }
  if (typeof body.notes === 'string' && body.notes.trim()) {
    booking.adminNotes = [booking.adminNotes, `Session: ${body.notes.trim()}`].filter(Boolean).join('\n');
  }
}

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

    // A treatment set to charge for online booking must go through payment —
    // this direct, pay-at-clinic path is only for those with the toggle off
    // (or no price). Prevents bypassing the payment gate from a client.
    if (consultation.chargeOnlineBooking !== false && consultation.price > 0) {
      return res.status(400).json({
        success: false,
        message: 'This treatment requires online payment. Please complete checkout to book.'
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

    const scheduleCheck = validateBranchBooking(
      branch,
      preferredDate,
      preferredTimeSlots
    );
    if (!scheduleCheck.ok) {
      return res.status(409).json({
        success: false,
        code: scheduleCheck.code,
        message: scheduleCheck.message
      });
    }

    // Create booking with pre-save hook for reference number.
    // `amount` is required by the model — for this pay-at-clinic path it records
    // the treatment price the guest will settle at the clinic (0 if priced on
    // consultation). paymentStatus stays 'pending' (nothing was paid online).
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
      amount: consultation.price || 0,
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
          timeSlots: booking.preferredTimeSlots.join(', '),
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
          timeSlots: booking.preferredTimeSlots.join(', '),
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
          timeSlots: booking.preferredTimeSlots.join(', '),
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

    const cancellableStatuses = ['Awaiting Confirmation', 'Confirmed', 'Rescheduled'];
    if (!cancellableStatuses.includes(booking.status)) {
      return res.status(400).json({
        success: false,
        code: 'BOOKING_NOT_CANCELLABLE',
        message: 'Booking cannot be cancelled at this stage'
      });
    }

    // The 24-hour window only applies once the clinic has actually confirmed a
    // time. While a booking is still "Awaiting Confirmation" the clinic hasn't
    // committed to it, so the guest can cancel at any point — even inside 24h.
    const windowEnforced = booking.status !== 'Awaiting Confirmation';
    if (windowEnforced && !booking.canBeCancelled()) {
      return res.status(409).json({
        success: false,
        code: 'CANCELLATION_WINDOW_CLOSED',
        message: "Appointments can't be cancelled within 24 hours of the scheduled check-in time. Please contact the clinic for help."
      });
    }

    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      return res.status(400).json({
        success: false,
        code: 'CANCELLATION_REASON_REQUIRED',
        message: 'Select a reason for cancelling this appointment.'
      });
    }

    booking.status = 'Cancelled';
    booking.cancellationReason = reason.trim();
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
          time: booking.preferredTimeSlots[0],
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
          time: booking.preferredTimeSlots[0],
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

    const reschedulableStatuses = ['Confirmed', 'Rescheduled'];
    if (!reschedulableStatuses.includes(booking.status)) {
      return res.status(400).json({
        success: false,
        code: 'BOOKING_NOT_RESCHEDULABLE',
        message: 'Booking cannot be rescheduled at this stage'
      });
    }

    if (!booking.canBeRescheduled()) {
      return res.status(409).json({
        success: false,
        code: 'RESCHEDULING_WINDOW_CLOSED',
        message: "Appointments can't be rescheduled within 24 hours of the scheduled check-in time. Please contact the clinic for help."
      });
    }

    // Remember the ORIGINAL confirmed slot, so the clinic can revert to it if it
    // declines the request.
    const originalDate = booking.confirmedDate || booking.preferredDate;
    const originalTime = booking.confirmedTime || booking.preferredTimeSlots[0];
    const oldDate = originalDate.toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });
    const oldTime = originalTime;

    booking.rescheduledFrom = { date: originalDate, time: originalTime };

    // This is a REQUEST: put the new times in as preferred and drop the
    // confirmed slot so the appointment goes back to "awaiting confirmation of
    // the new time" (status Rescheduled). The clinic then accepts or declines.
    booking.preferredDate = new Date(newDate);
    booking.preferredTimeSlots = newTimeSlots;
    booking.confirmedDate = undefined;
    booking.confirmedTime = undefined;
    booking.status = 'Rescheduled';
    booking.rescheduleRejected = false;
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
        confirmedDate: booking.preferredDate,
        confirmedTime: booking.preferredTimeSlots[0]
      });
      console.log('🔔 Booking reschedule request notification created');
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
          newTime: booking.preferredTimeSlots[0],
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
          newTime: booking.preferredTimeSlots[0],
          location: booking.preferredLocation
        }
      );
      console.log('WhatsApp reschedule notification sent');
    } catch (whatsappError) {
      console.error('WhatsApp sending failed:', whatsappError.message);
    }

    res.status(200).json({
      success: true,
      message: 'Reschedule requested — the clinic will confirm one of your new times shortly.',
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

// @desc    Reject a guest's reschedule request (Admin) → revert to original slot
// @route   PUT /api/bookings/admin/:id/reject-reschedule
// @access  Private (Admin)
exports.rejectReschedule = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) {
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }
    if (booking.status !== 'Rescheduled') {
      return res.status(400).json({ success: false, message: 'No reschedule request is pending on this booking' });
    }

    // Put the appointment back on its original confirmed slot.
    const original = booking.rescheduledFrom || {};
    if (original.date) {
      booking.confirmedDate = original.date;
      booking.confirmedTime = original.time;
      booking.preferredDate = original.date;
      booking.preferredTimeSlots = original.time ? [original.time] : booking.preferredTimeSlots;
    }
    booking.status = 'Confirmed';
    booking.rescheduleRejected = true;
    await booking.save();
    await booking.populate('consultationId', 'name');

    try {
      await NotificationHelper.create({
        userId: booking.userId,
        type: 'booking',
        title: 'Reschedule Not Possible',
        message: `We couldn't reschedule your appointment for ${booking.consultationId?.name || 'your appointment'}. Your original time still stands — or you can cancel and book a new one.`,
        relatedId: booking._id,
        relatedModel: 'Booking',
        priority: 'high',
        metadata: { bookingId: booking._id }
      });
    } catch (e) { console.error('⚠️ reschedule-reject notification failed:', e.message); }

    res.status(200).json({ success: true, message: 'Reschedule declined — original time kept', data: booking });
  } catch (error) {
    console.error('❌ Reject reschedule error:', error);
    res.status(500).json({ success: false, message: 'Failed to reject the reschedule' });
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

    // Send WhatsApp check-in notification
    try {
      await whatsappService.sendCheckInSuccessful(
        booking.mobileNumber,
        {
          patientName: booking.fullName,
          treatment: booking.consultationId.name,
          time: booking.preferredTimeSlots[0],
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
          time: booking.preferredTimeSlots[0],
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
    const { status, location, branchId, date, startDate: from, endDate: to, search, userId, specialistId, therapistId, page, limit } = req.query;

    // Build query
    const query = {};

    if (status && status !== 'all') {
      query.status = status;
    }

    if (branchId) {
      query.branchId = branchId;
    } else if (location && location !== 'all') {
      query.preferredLocation = location;
    }

    if (userId) query.userId = userId;
    if (specialistId) query.specialistId = String(specialistId).toLowerCase();
    if (therapistId) query.therapistId = therapistId;

    if (date) {
      const startDate = new Date(date);
      startDate.setHours(0, 0, 0, 0);
      const endDate = new Date(date);
      endDate.setHours(23, 59, 59, 999);
      // A rescheduled booking lives on its confirmed date, not the one first asked for.
      query.$and = [{
        $or: [
          { confirmedDate: { $gte: startDate, $lte: endDate } },
          { confirmedDate: { $in: [null, undefined] }, preferredDate: { $gte: startDate, $lte: endDate } },
        ],
      }];
    } else if (from || to) {
      query.preferredDate = {};
      if (from) { const d = new Date(from); d.setHours(0, 0, 0, 0); query.preferredDate.$gte = d; }
      if (to) { const d = new Date(to); d.setHours(23, 59, 59, 999); query.preferredDate.$lte = d; }
    }

    if (search) {
      query.$or = [
        { fullName: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { mobileNumber: { $regex: search, $options: 'i' } },
        { referenceNumber: { $regex: search, $options: 'i' } }
      ];
    }

    // Pagination is opt-in (`limit`) so existing callers keep the full list.
    const perPage = limit ? Math.min(500, Math.max(1, parseInt(limit, 10))) : null;
    const pageNo = Math.max(1, parseInt(page || '1', 10));

    let find = Booking.find(query)
      .populate('consultationId', 'name category price image')
      .populate('userId', 'fullName email phone patientId')
      .populate('branchId', 'name address')
      .sort({ createdAt: -1 })
      .select('-__v');
    if (perPage) find = find.skip((pageNo - 1) * perPage).limit(perPage);

    const [bookings, total, statusCounts] = await Promise.all([
      find,
      Booking.countDocuments(query),
      // Counts per status for the same scope minus the status filter — the tab badges.
      Booking.aggregate([
        { $match: Object.fromEntries(Object.entries(query).filter(([k]) => k !== 'status')) },
        { $group: { _id: '$status', n: { $sum: 1 } } },
      ]),
    ]);

    res.status(200).json({
      success: true,
      count: bookings.length,
      total,
      statusCounts: Object.fromEntries(statusCounts.map((r) => [r._id, r.n])),
      pagination: perPage ? { currentPage: pageNo, totalPages: Math.ceil(total / perPage), total } : undefined,
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

    if (!['Confirmed', 'Rescheduled', 'Awaiting Confirmation'].includes(booking.status)) {
      return res.status(400).json({
        success: false,
        message: 'Only upcoming bookings can be marked as no-show'
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
      .populate('userId', 'fullName email phone patientId');

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
    if (booking.checkInTime) {
      booking.sessionDuration = Math.max(0, Math.round((booking.checkOutTime - booking.checkInTime) / 60000));
    }
    applySessionFromBody(booking, req);

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

/* ===========================================================================
 * Visit codes — the guest reads a code to reception, who verifies it in the
 * panel. The code appears in the app (and on email + WhatsApp) 1 hour before
 * the appointment (check-in), and again once the guest is checked in (check-out).
 * ======================================================================== */

const HM_RE = /^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i;

/** Parse "9:00 AM" / "14:30" / "09:00" into {h, m}, or null. */
function parseTimeToHM(value) {
  const m = String(value || '').trim().match(HM_RE);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ap = m[3] ? m[3].toUpperCase() : null;
  if (ap === 'PM' && h < 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return { h, m: min };
}

/** The appointment's start Date, from the confirmed (or preferred) date + time. */
function appointmentStart(booking) {
  const dateSrc = booking.confirmedDate || booking.preferredDate;
  if (!dateSrc) return null;
  const d = new Date(dateSrc);
  const timeStr = booking.confirmedTime || booking.slotTime ||
    (booking.preferredTimeSlots && booking.preferredTimeSlots[0]);
  const hm = parseTimeToHM(timeStr);
  if (hm) d.setHours(hm.h, hm.m, 0, 0);
  return d;
}

const genVisitCode = () => String(Math.floor(100000 + Math.random() * 900000));

/** Send a freshly generated code to the guest by email + WhatsApp (non-blocking). */
async function deliverVisitCode(booking, kind, code) {
  const label = kind === 'check-in' ? 'check-in' : 'check-out';
  try {
    await emailService.sendVisitCodeEmail(booking.email, booking.fullName, {
      code,
      kind: label,
      referenceNumber: booking.referenceNumber,
      treatment: booking.consultationId && booking.consultationId.name,
      location: booking.preferredLocation,
    });
  } catch (e) {
    console.error('⚠️ Visit-code email failed:', e.message);
  }
  try {
    const tail = kind === 'check-out' ? 'to complete your visit' : 'to check in';
    await whatsappService.sendMessage(
      booking.mobileNumber,
      `Your Zennara ${label} code is ${code}. Show it at reception ${tail}. (Ref ${booking.referenceNumber})`,
    );
  } catch (e) {
    console.error('⚠️ Visit-code WhatsApp failed:', e.message);
  }
}

// @desc    Get / generate the guest's current visit code
// @route   GET /api/bookings/:id/visit-code
// @access  Private (owner)
exports.getVisitCode = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id).populate('consultationId', 'name');
    if (!booking) {
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }
    if (String(booking.userId) !== String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Not your booking' });
    }

    // Check-out stage — the guest is in the chair.
    if (booking.status === 'In Progress') {
      let fresh = false;
      if (!booking.checkOutCode) {
        booking.checkOutCode = genVisitCode();
        booking.checkOutCodeAt = new Date();
        await booking.save();
        fresh = true;
      }
      if (fresh) deliverVisitCode(booking, 'check-out', booking.checkOutCode);
      return res.status(200).json({
        success: true,
        data: { stage: 'checkout', code: booking.checkOutCode, message: 'Read this code to reception to complete your visit.' },
      });
    }

    if (booking.status === 'Completed') {
      return res.status(200).json({ success: true, data: { stage: 'done', message: 'This visit is complete.' } });
    }
    if (booking.status === 'Cancelled') {
      return res.status(200).json({ success: true, data: { stage: 'none', message: 'No check-in code for this appointment.' } });
    }
    if (booking.status === 'Awaiting Confirmation') {
      return res.status(200).json({ success: true, data: { stage: 'pending', message: 'Your booking is awaiting clinic confirmation.' } });
    }
    if (booking.status === 'Rescheduled') {
      return res.status(200).json({ success: true, data: { stage: 'pending', message: 'Your reschedule request is awaiting clinic confirmation.' } });
    }

    // Confirmed / No Show (late arrival) — the check-in code opens 1 hour before
    // the slot and stays available so staff can still check a late guest in with
    // it (verify-checkin also accepts No Show).
    const start = appointmentStart(booking);
    const WINDOW = 60 * 60 * 1000;
    if (start && Date.now() < start.getTime() - WINDOW) {
      return res.status(200).json({
        success: true,
        data: {
          stage: 'early',
          availableAt: new Date(start.getTime() - WINDOW).toISOString(),
          message: 'Your check-in code appears 1 hour before your appointment.',
        },
      });
    }

    let fresh = false;
    if (!booking.checkInCode) {
      booking.checkInCode = genVisitCode();
      booking.checkInCodeAt = new Date();
      await booking.save();
      fresh = true;
    }
    if (fresh) deliverVisitCode(booking, 'check-in', booking.checkInCode);
    return res.status(200).json({
      success: true,
      data: { stage: 'checkin', code: booking.checkInCode, message: 'Show this code at reception to check in.' },
    });
  } catch (error) {
    console.error('❌ Get visit code error:', error);
    res.status(500).json({ success: false, message: 'Could not load your visit code.' });
  }
};

// @desc    Staff verifies the guest's check-in code → In Progress
// @route   PUT /api/bookings/admin/:id/verify-checkin
// @access  Private (Admin)
exports.verifyCheckInCode = async (req, res) => {
  try {
    const code = String((req.body && req.body.code) || '').trim();
    const booking = await Booking.findById(req.params.id);
    if (!booking) {
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }
    if (!['Confirmed', 'No Show'].includes(booking.status)) {
      return res.status(400).json({ success: false, message: 'Only confirmed bookings can be checked in' });
    }
    if (!booking.checkInCode) {
      return res.status(400).json({ success: false, message: "The guest hasn't generated a check-in code yet — ask them to open the appointment in the Zennara app." });
    }
    if (code !== booking.checkInCode) {
      return res.status(400).json({ success: false, message: "That code doesn't match. Please ask the guest to read it again." });
    }

    booking.status = 'In Progress';
    booking.checkInTime = new Date();
    booking.checkInCode = null;
    booking.checkInCodeAt = null;
    await booking.save();
    await booking.populate('consultationId', 'name');

    try {
      await NotificationHelper.bookingCheckedIn({
        _id: booking._id,
        patientName: booking.fullName,
        consultation: { name: booking.consultationId.name },
        checkInTime: booking.checkInTime,
      });
    } catch (e) { console.error('⚠️ check-in notification failed:', e.message); }

    try {
      await emailService.sendCheckInSuccessful(booking.email, booking.fullName, {
        treatment: booking.consultationId.name,
        time: booking.confirmedTime || booking.preferredTimeSlots[0],
        location: booking.preferredLocation,
        waitTime: '5-10',
      }, booking.preferredLocation);
    } catch (e) { console.error('⚠️ check-in email failed:', e.message); }

    try {
      await whatsappService.sendCheckInSuccessful(booking.mobileNumber, {
        patientName: booking.fullName,
        treatment: booking.consultationId.name,
        time: booking.confirmedTime || booking.preferredTimeSlots[0],
        location: booking.preferredLocation,
        waitTime: '5-10',
      });
    } catch (e) { console.error('⚠️ check-in WhatsApp failed:', e.message); }

    res.status(200).json({ success: true, message: 'Guest checked in', data: booking });
  } catch (error) {
    console.error('❌ Verify check-in error:', error);
    res.status(500).json({ success: false, message: 'Failed to check in' });
  }
};

// @desc    Staff verifies the guest's check-out code → Completed
// @route   PUT /api/bookings/admin/:id/verify-checkout
// @access  Private (Admin)
exports.verifyCheckOutCode = async (req, res) => {
  try {
    const code = String((req.body && req.body.code) || '').trim();
    const booking = await Booking.findById(req.params.id);
    if (!booking) {
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }
    if (booking.status !== 'In Progress') {
      return res.status(400).json({ success: false, message: 'Only in-progress bookings can be checked out' });
    }
    if (!booking.checkOutCode) {
      return res.status(400).json({ success: false, message: "The guest hasn't generated a check-out code yet — ask them to open the appointment in the Zennara app." });
    }
    if (code !== booking.checkOutCode) {
      return res.status(400).json({ success: false, message: "That code doesn't match. Please ask the guest to read it again." });
    }

    booking.status = 'Completed';
    booking.checkOutTime = new Date();
    if (booking.checkInTime) {
      booking.sessionDuration = Math.max(0, Math.round((booking.checkOutTime - booking.checkInTime) / 60000));
    }
    applySessionFromBody(booking, req);
    booking.checkOutCode = null;
    booking.checkOutCodeAt = null;
    applySessionFromBody(booking, req);
    await booking.save();
    await booking.populate('consultationId', 'name');

    const dateLabel = (booking.confirmedDate || booking.preferredDate)
      .toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    try {
      await NotificationHelper.bookingCompleted({
        _id: booking._id,
        userId: booking.userId,
        patientName: booking.fullName,
        consultation: { name: booking.consultationId.name },
        checkOutTime: booking.checkOutTime,
      });
    } catch (e) { console.error('⚠️ completion notification failed:', e.message); }

    try {
      await emailService.sendAppointmentCompleted(booking.email, booking.fullName, {
        treatment: booking.consultationId.name,
        date: dateLabel,
        location: booking.preferredLocation,
      }, booking.preferredLocation);
    } catch (e) { console.error('⚠️ completion email failed:', e.message); }

    try {
      await whatsappService.sendAppointmentCompleted(booking.mobileNumber, {
        patientName: booking.fullName,
        treatment: booking.consultationId.name,
        date: dateLabel,
        location: booking.preferredLocation,
        sessionDuration: booking.sessionDuration,
        bookingId: booking._id,
      });
    } catch (e) { console.error('⚠️ completion WhatsApp failed:', e.message); }

    res.status(200).json({ success: true, message: 'Guest checked out — visit complete', data: booking });
  } catch (error) {
    console.error('❌ Verify check-out error:', error);
    res.status(500).json({ success: false, message: 'Failed to check out' });
  }
};

// @desc    Cancel booking (Admin)
// @route   PUT /api/bookings/admin/:id/cancel
// @access  Private (Admin)
exports.cancelBookingAdmin = async (req, res) => {
  try {
    const reason = req.body.reason || req.body.cancellationReason;

    const booking = await Booking.findById(req.params.id);

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    // The desk can cancel anything that has not already ended.
    if (['Cancelled', 'Completed', 'No Show'].includes(booking.status)) {
      return res.status(400).json({
        success: false,
        message: `A ${booking.status.toLowerCase()} booking cannot be cancelled`
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

    // Use the same hourly branch engine as the active treatment flow. This
    // endpoint remains as a compatibility fallback for older mobile builds,
    // so it must not carry a second hardcoded calendar.
    const escaped = String(location).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const branch = await Branch.findOne({
      name: { $regex: `^${escaped}$`, $options: 'i' },
      isActive: true,
    });
    const allSlots = branch ? branch.getAvailableSlots(new Date(date)) : [];

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
        bookedSlots,
        slotDuration: SESSION_SLOT_MINUTES,
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

// @desc    Create a booking from the panel (walk-in or phone booking)
// @route   POST /api/bookings/admin
// @access  Private (Admin)
//
// Reception needs to put a guest in the book without going through the app's
// pay-then-book flow. The guest may not exist yet, so this resolves — or
// creates — a User from the phone number, which is also what links them to the
// app later.
exports.createBookingAdmin = async (req, res) => {
  try {
    const {
      consultationId,
      fullName,
      mobileNumber,
      email,
      preferredLocation,
      preferredDate,
      preferredTimeSlots,
      specialistId,
      specialistName,
      specialistTier,
      amount,
      paymentStatus,
      notes,
      confirmNow,
      userId,
    } = req.body;

    if (!consultationId || !fullName || !mobileNumber || !preferredLocation || !preferredDate) {
      return res.status(400).json({
        success: false,
        message: 'consultationId, fullName, mobileNumber, preferredLocation and preferredDate are required',
      });
    }

    const consultation = await Consultation.findById(consultationId);
    if (!consultation) {
      return res.status(404).json({ success: false, message: 'Service not found' });
    }

    const branch = await Branch.findOne({ name: preferredLocation, isActive: true });
    if (!branch) {
      return res.status(404).json({ success: false, message: 'Branch not found or inactive' });
    }

    // Resolve the guest: explicit id, then phone, then email, else create one.
    let user = null;
    if (userId) user = await User.findById(userId);
    if (!user) user = await User.findOne({ phone: mobileNumber });
    if (!user && email) user = await User.findOne({ email: String(email).toLowerCase() });

    let createdUser = false;
    if (!user) {
      // A walk-in has no email until they give one; synthesise a unique
      // placeholder so the account can exist and be claimed later.
      const safeEmail = email
        ? String(email).toLowerCase()
        : `walkin.${mobileNumber.replace(/\D/g, '')}@zennara.local`;

      user = await User.create({
        fullName,
        email: safeEmail,
        phone: mobileNumber,
        location: preferredLocation,
        dateOfBirth: req.body.dateOfBirth || '',
        gender: req.body.gender || 'Other',
        isVerified: false,
        isActive: true,
      });
      createdUser = true;
    }

    const slots = Array.isArray(preferredTimeSlots) && preferredTimeSlots.length
      ? preferredTimeSlots
      : [req.body.confirmedTime].filter(Boolean);

    if (!slots.length) {
      return res.status(400).json({
        success: false,
        message: 'At least one preferred time slot is required',
      });
    }

    const booking = new Booking({
      userId: user._id,
      consultationId,
      fullName,
      mobileNumber,
      email: user.email,
      branchId: branch._id,
      preferredLocation,
      preferredDate: new Date(preferredDate),
      preferredTimeSlots: slots,
      specialistId: specialistId || undefined,
      specialistName: specialistName || undefined,
      specialistTier: specialistTier || undefined,
      amount: amount !== undefined && amount !== null ? Number(amount) : consultation.price,
      paymentStatus: paymentStatus || 'pending',
      status: confirmNow ? 'Confirmed' : 'Awaiting Confirmation',
      notes: notes || undefined,
      source: 'reception',
      adminNotes: `Created at reception by ${req.admin?.email || 'admin'}`,
    });

    if (confirmNow) {
      booking.confirmedDate = new Date(preferredDate);
      booking.confirmedTime = slots[0];
    }

    await booking.save();
    await booking.populate('consultationId', 'name category price image');
    await booking.populate('userId', 'fullName email phone patientId');

    try {
      await NotificationHelper.bookingCreated({
        _id: booking._id,
        userId: booking.userId._id || booking.userId,
        patientName: booking.fullName,
        consultation: { name: consultation.name },
        branch: { name: branch.name },
        appointmentDate: booking.preferredDate,
      });
    } catch (notifError) {
      console.error('⚠️ Failed to create notification:', notifError.message);
    }

    // Best-effort confirmations — a messaging outage must not lose the booking.
    try {
      await whatsappService.sendBookingConfirmation(booking.mobileNumber, {
        patientName: booking.fullName,
        referenceNumber: booking.referenceNumber,
        treatment: consultation.name,
        date: booking.preferredDate.toLocaleDateString('en-US', {
          weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        }),
        timeSlots: booking.preferredTimeSlots.join(', '),
        location: booking.preferredLocation,
      });
    } catch (whatsappError) {
      console.error('WhatsApp send failed, booking still created:', whatsappError.message);
    }

    if (email) {
      try {
        await emailService.sendAppointmentBookingConfirmation(
          booking.email,
          booking.fullName,
          {
            referenceNumber: booking.referenceNumber,
            treatment: consultation.name,
            category: consultation.category,
            preferredDate: booking.preferredDate.toLocaleDateString('en-US', {
              weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
            }),
            timeSlots: booking.preferredTimeSlots.join(', '),
            location: booking.preferredLocation,
          },
          booking.preferredLocation,
        );
      } catch (emailError) {
        console.error('Email send failed, booking still created:', emailError.message);
      }
    }

    return res.status(201).json({
      success: true,
      message: createdUser
        ? `Booking created and a new patient record was opened for ${fullName}.`
        : 'Booking created successfully',
      data: booking,
      meta: { createdUser, patientId: user.patientId },
    });
  } catch (error) {
    console.error('❌ Admin create booking error:', error);
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        message: Object.values(error.errors).map((e) => e.message).join(', '),
      });
    }
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to create booking',
    });
  }
};

// @desc    Reschedule a booking from the panel
// @route   PUT /api/bookings/admin/:id/reschedule
// @access  Private (Admin)
exports.rescheduleBookingAdmin = async (req, res) => {
  try {
    const { preferredDate, confirmedTime, preferredTimeSlots, reason } = req.body;

    const booking = await Booking.findById(req.params.id);
    if (!booking) {
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }

    if (['Cancelled', 'Completed', 'No Show'].includes(booking.status)) {
      return res.status(400).json({
        success: false,
        message: `A ${booking.status.toLowerCase()} booking cannot be rescheduled`,
      });
    }

    if (!preferredDate) {
      return res.status(400).json({ success: false, message: 'A new date is required' });
    }

    booking.rescheduledFrom = {
      date: booking.confirmedDate || booking.preferredDate,
      time: booking.confirmedTime || booking.preferredTimeSlots?.[0],
    };
    booking.rescheduledAt = new Date();
    booking.preferredDate = new Date(preferredDate);
    if (Array.isArray(preferredTimeSlots) && preferredTimeSlots.length) {
      booking.preferredTimeSlots = preferredTimeSlots;
    }
    if (confirmedTime) {
      booking.confirmedDate = new Date(preferredDate);
      booking.confirmedTime = confirmedTime;
      booking.status = 'Confirmed';
    } else {
      booking.status = 'Rescheduled';
      booking.confirmedDate = undefined;
      booking.confirmedTime = undefined;
    }
    if (reason) {
      booking.adminNotes = `${booking.adminNotes ? `${booking.adminNotes}\n` : ''}Rescheduled: ${reason}`;
    }

    await booking.save();
    await booking.populate('consultationId', 'name category price image');
    await booking.populate('userId', 'fullName email phone patientId');

    return res.status(200).json({
      success: true,
      message: 'Booking rescheduled',
      data: booking,
    });
  } catch (error) {
    console.error('❌ Admin reschedule error:', error);
    return res.status(500).json({ success: false, message: 'Failed to reschedule booking' });
  }
};


// @desc    Record the payment on a booking (desk payments — cash, card, UPI, package)
// @route   PUT /api/bookings/admin/:id/payment
// @access  Private (Admin)
exports.updateBookingPaymentAdmin = async (req, res) => {
  try {
    const { paymentStatus, paymentMethod, amount, note } = req.body;
    const booking = await Booking.findById(req.params.id);
    if (!booking) {
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }

    const allowedStatus = ['pending', 'paid', 'failed', 'refunded'];
    if (paymentStatus !== undefined) {
      if (!allowedStatus.includes(paymentStatus)) {
        return res.status(400).json({ success: false, message: `paymentStatus must be one of ${allowedStatus.join(', ')}` });
      }
      booking.paymentStatus = paymentStatus;
      if (paymentStatus === 'paid' && !booking.paidAt) booking.paidAt = new Date();
      if (paymentStatus !== 'paid') booking.paidAt = undefined;
    }
    if (paymentMethod !== undefined) booking.paymentMethod = paymentMethod;
    if (amount !== undefined && amount !== null && amount !== '') {
      const n = Number(amount);
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({ success: false, message: 'amount must be a non-negative number' });
      }
      booking.amount = n;
    }
    if (note && String(note).trim()) {
      booking.adminNotes = [booking.adminNotes, `Payment: ${String(note).trim()} (${req.admin?.email || 'admin'})`]
        .filter(Boolean).join('\n');
    }

    await booking.save();
    await booking.populate('consultationId', 'name category price image');
    await booking.populate('userId', 'fullName email phone patientId');

    return res.status(200).json({ success: true, message: 'Payment updated', data: booking });
  } catch (error) {
    console.error('Update booking payment error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update payment', error: error.message });
  }
};

// @desc    Append a desk note to a booking
// @route   PUT /api/bookings/admin/:id/notes
// @access  Private (Admin)
exports.addBookingNoteAdmin = async (req, res) => {
  try {
    const text = String(req.body.note || '').trim();
    if (!text) return res.status(400).json({ success: false, message: 'Note is required' });
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    booking.adminNotes = [booking.adminNotes, `[${stamp} ${req.admin?.email || 'admin'}] ${text}`].filter(Boolean).join('\n');
    await booking.save();
    return res.status(200).json({ success: true, data: booking });
  } catch (error) {
    console.error('Add booking note error:', error);
    return res.status(500).json({ success: false, message: 'Failed to add note', error: error.message });
  }
};
