const Booking = require('../models/Booking');
const zenotiWrite = require('../services/zenotiWriteService');

/** A dermatologist login only ever sees its own diary, whatever specialistId it asks for. */
async function scopeToOwnDiary(req, query) {
  if (req.admin?.role !== 'doctor') return;
  const mine = await require('../utils/doctorIdentity').resolveDoctorForAdmin(req).catch(() => null);
  query.specialistId = mine ? mine.doctorId : '__none__';
}
const { publicEmail, isPlaceholderEmail } = require('../config/zenoti');
const { buildBookingQuery } = require('../utils/listFilters');
const visitCodes = require('../utils/visitCodes');
const Doctor = require('../models/Doctor');
const Consultation = require('../models/Consultation');
const User = require('../models/User');
const Branch = require('../models/Branch');
const emailService = require('../utils/emailService');
const NotificationHelper = require('../utils/notificationHelper');
const whatsappService = require('../services/whatsappService');
const twilioVoiceService = require('../services/twilioVoiceService');
const {
  bookingScheduledAt, clinicDateKey, clinicDayEnd, clinicDayStart, formatClinicDateTime,
} = require('../utils/bookingTime');
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
      preferredDate: clinicDayStart(preferredDate),
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

    // An appointment booked in Zenoti is changed in Zenoti, always: a change
    // made only here would leave the clinic's diary expecting the guest (see
    // ZENOTI-NO-SHOW-INCIDENT).
    if (booking.source === 'zenoti') {
      return res.status(409).json({
        success: false,
        code: 'CLINIC_BOOKING_CHANGE_AT_CLINIC',
        message: 'This appointment was booked at the clinic. Please call the clinic to change or cancel it — changes made there appear here within a few minutes.'
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

    // An appointment booked in Zenoti is changed in Zenoti, always: a change
    // made only here would leave the clinic's diary expecting the guest (see
    // ZENOTI-NO-SHOW-INCIDENT).
    if (booking.source === 'zenoti') {
      return res.status(409).json({
        success: false,
        code: 'CLINIC_BOOKING_CHANGE_AT_CLINIC',
        message: 'This appointment was booked at the clinic. Please call the clinic to change or cancel it — changes made there appear here within a few minutes.'
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
    // The diary reads slotTime against preferredDate — left as the OLD time it
    // would block the wrong slot on the NEW date. While the request is pending
    // the new preferred times hold the diary; declining restores the original
    // hold through confirmedTime.
    if (booking.slotTime) booking.slotTime = null;
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
    // A rating never rewrites the visit itself: the real check-out time (and
    // the session duration derived from it) must stay what the desk recorded.
    booking.$locals.skipZenotiWrite = true;

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
    const { page, limit } = req.query;

    // Filters + sort are shared with the export endpoint (utils/listFilters).
    const { query, sort } = await buildBookingQuery(req.query);
    await scopeToOwnDiary(req, query);

    // Pagination is opt-in (`limit`) so existing callers keep the full list.
    const perPage = limit ? Math.min(500, Math.max(1, parseInt(limit, 10))) : null;
    const pageNo = Math.max(1, parseInt(page || '1', 10));

    // Plain objects: the populated Branch carries virtuals that assume a full
    // document and throw on this partial projection, which took the whole
    // bookings page down when rows were serialised with virtuals.
    let find = Booking.find(query)
      .populate('consultationId', 'name category price image')
      .populate('userId', 'fullName email phone patientId')
      .populate('branchId', 'name address')
      .sort(sort)
      .select('-__v')
      .lean();
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

    // Guest identity comes from the account, never from an internal
    // placeholder: fill a blank/placeholder name, phone or email from the
    // populated user so the panel always shows who the visit is for.
    const rows = bookings.map((o) => {
      const u = o.userId && typeof o.userId === 'object' ? o.userId : null;
      if (u) {
        if ((!o.fullName || o.fullName === 'Zennara Guest') && u.fullName) o.fullName = u.fullName;
        if (!o.mobileNumber && u.phone) o.mobileNumber = u.phone;
        if ((!o.email || isPlaceholderEmail(o.email)) && publicEmail(u.email)) o.email = publicEmail(u.email);
        u.email = publicEmail(u.email);
      }
      if (isPlaceholderEmail(o.email)) o.email = '';
      return o;
    });

    res.status(200).json({
      success: true,
      count: rows.length,
      total,
      statusCounts: Object.fromEntries(statusCounts.map((r) => [r._id, r.n])),
      pagination: perPage ? { currentPage: pageNo, totalPages: Math.ceil(total / perPage), total } : undefined,
      data: rows
    });
  } catch (error) {
    console.error('❌ Get all bookings admin error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch bookings'
    });
  }
};

// @desc    Export bookings matching the same filters as the list (Admin)
// @route   GET /api/bookings/admin/export
// @access  Private (Admin)
exports.exportBookingsAdmin = async (req, res) => {
  try {
    const { query, sort } = await buildBookingQuery(req.query);
    await scopeToOwnDiary(req, query);
    const limit = Math.min(20000, Math.max(1, parseInt(req.query.limit || '20000', 10)));
    const bookings = await Booking.find(query)
      .populate('consultationId', 'name category type price')
      .populate('userId', 'fullName email phone patientId memberType')
      .populate('branchId', 'name')
      .sort(sort)
      .limit(limit)
      .lean();

    const fmtDate = (d) => (d ? clinicDateKey(d) || '' : '');
    const fmtWhen = (d) => (d ? formatClinicDateTime(d) : '');
    const rows = bookings.map((b) => {
      const slotDate = b.confirmedDate || b.preferredDate;
      const slotTime = b.confirmedTime || b.slotTime || (b.preferredTimeSlots && b.preferredTimeSlots[0]) || '';
      return {
        'Reference': b.referenceNumber || '',
        'Guest': (b.userId && b.userId.fullName) || b.fullName || '',
        'Patient ID': (b.userId && b.userId.patientId) || '',
        'Phone': b.mobileNumber || (b.userId && b.userId.phone) || '',
        'Email': /@guest\.zennara\.in$/i.test(b.email || '') ? '' : (b.email || ''),
        'Membership': (b.userId && b.userId.memberType) || '',
        'Service': (b.consultationId && b.consultationId.name) || b.externalServiceName || '',
        'Category': (b.consultationId && b.consultationId.category) || b.externalServiceCategory || '',
        'Kind': /consultation/i.test(((b.consultationId && (b.consultationId.category + ' ' + b.consultationId.name)) || b.externalServiceName || '')) ? 'Consultation' : 'Treatment',
        'Centre': (b.branchId && b.branchId.name) || b.preferredLocation || '',
        'Date': fmtDate(slotDate),
        'Time': slotTime,
        'Status': b.status,
        'Dermatologist': b.specialistName || '',
        'Therapist': b.therapistName || '',
        'Room': b.room || '',
        'Source': b.source || 'app',
        'Package': b.isPackageIncluded ? 'Yes' : 'No',
        'Amount': b.amount || 0,
        'Payment Status': b.paymentStatus || '',
        'Payment Method': b.paymentMethod || '',
        'Paid At': fmtWhen(b.paidAt),
        'Checked In': fmtWhen(b.checkInTime),
        'Checked Out': fmtWhen(b.checkOutTime),
        'Session Minutes': b.sessionDuration || '',
        'Rating': b.rating || '',
        'Cancellation Reason': b.cancellationReason || '',
        'Booked On': fmtWhen(b.createdAt),
        'Notes': b.notes || '',
      };
    });
    const fields = String(req.query.fields || '').split(',').map((f) => f.trim()).filter(Boolean);
    const out = fields.length ? rows.map((r) => Object.fromEntries(fields.filter((f) => f in r).map((f) => [f, r[f]]))) : rows;
    res.status(200).json({ success: true, count: out.length, data: out });
  } catch (error) {
    console.error('❌ Export bookings failed:', error);
    res.status(500).json({ success: false, message: 'Failed to export bookings' });
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

    // Confirming a dermatologist consultation onto a time another guest holds
    // would double-book the diary. Same guard as reschedule: only a genuine
    // clash blocks; leave/hours problems remain a staff judgement call.
    if (booking.specialistId && confirmedTime) {
      const { isSlotBookable } = require('../utils/dermatologistSlots');
      const key = clinicDateKey(confirmedDate || booking.preferredDate);
      const check = key
        ? await isSlotBookable(booking.specialistId, key, confirmedTime, {
            branchId: booking.branchId || null,
            excludeBookingId: booking._id,
          })
        : { ok: true };
      if (!check.ok && check.reason === 'already-booked') {
        return res.status(409).json({
          success: false,
          code: 'DERMATOLOGIST_SLOT_UNAVAILABLE',
          message: 'Another guest already holds that time with this dermatologist. Pick a different slot.',
        });
      }
    }

    booking.status = 'Confirmed';
    booking.confirmedDate = clinicDayStart(confirmedDate);
    booking.confirmedTime = confirmedTime;
    // Keep the diary's primary field in step for calendar-booked consults.
    if (booking.slotTime) booking.slotTime = confirmedTime || booking.slotTime;

    booking.$locals.zenotiStaffAction = true; // a person at the desk decided this
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
    if (booking.source === 'zenoti') {
      return res.status(409).json({
        success: false,
        code: 'ZENOTI_OWNED_APPOINTMENT',
        message: 'This appointment was booked in Zenoti. Mark the no-show in Zenoti — it appears here within 2 minutes.'
      });
    }

    if (!['Confirmed', 'Rescheduled', 'Awaiting Confirmation'].includes(booking.status)) {
      return res.status(400).json({
        success: false,
        message: 'Only upcoming bookings can be marked as no-show'
      });
    }

    booking.status = 'No Show';
    booking.$locals.zenotiStaffAction = true; // a person at the desk decided this
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

    if (!['Confirmed', 'Rescheduled', 'No Show'].includes(booking.status)) {
      return res.status(400).json({
        success: false,
        message: 'Only confirmed bookings can be checked in'
      });
    }

    // Manual (no-code) check-in: used when the guest has no app and no way to
    // receive the code. Always recorded with who did it and why.
    const reason = String((req.body && req.body.reason) || '').trim();
    if (!reason) {
      return res.status(400).json({ success: false, message: 'A reason is required to check in without a code.' });
    }
    await applyDermatologist(booking, req.body);
    booking.status = 'In Progress';
    booking.checkInTime = new Date();
    booking.checkInCode = null;
    booking.manualCheckIn = { reason, by: req.admin && req.admin._id, byName: req.admin && req.admin.name, at: new Date() };

    // Populate consultation details for email
    await booking.populate('consultationId', 'name');
    await visitCodes.deliver(booking, 'checkout', { by: req.admin });
    booking.$locals.zenotiStaffAction = true; // a person at the desk decided this
    await booking.save();
    await notifyManualCheck(booking, 'checkin');

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

    const reason = String((req.body && req.body.reason) || '').trim();
    if (!reason) {
      return res.status(400).json({ success: false, message: 'A reason is required to check out without a code.' });
    }
    booking.status = 'Completed';
    booking.checkOutTime = new Date();
    booking.checkOutCode = null;
    booking.manualCheckOut = { reason, by: req.admin && req.admin._id, byName: req.admin && req.admin.name, at: new Date() };
    if (booking.checkInTime) {
      booking.sessionDuration = Math.max(0, Math.round((booking.checkOutTime - booking.checkInTime) / 60000));
    }
    applySessionFromBody(booking, req);

    booking.$locals.zenotiStaffAction = true; // a person at the desk decided this
    await booking.save();
    await booking.populate('consultationId', 'name');
    await notifyManualCheck(booking, 'checkout');

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

/** The appointment's start Date, from the confirmed (or preferred) date + time. */
function appointmentStart(booking) {
  return bookingScheduledAt(booking);
}


/**
 * Tell the guest that reception started / closed their session without a
 * code: an in-app notification plus an email. Never throws.
 */
async function notifyManualCheck(booking, kind) {
  const isOut = kind === 'checkout';
  const treatment = (booking.consultationId && booking.consultationId.name) || booking.externalServiceName || 'your appointment';
  const line = isOut ? 'You are checked out without code for this session.' : 'You are checked in without code for this session.';
  try {
    if (booking.userId) {
      await NotificationHelper.create({
        userId: booking.userId,
        type: 'booking',
        title: isOut ? 'Session completed' : 'Session started',
        message: `${line} ${treatment}${booking.preferredLocation ? ` · ${booking.preferredLocation}` : ''}`,
        relatedId: booking._id,
        relatedModel: 'Booking',
        priority: 'medium',
      });
    }
  } catch (e) { console.error('⚠️ Manual check notification failed:', e.message); }
  try {
    if (booking.email && !/@guest\.zennara\.in$|@zennara\.local$/i.test(booking.email)) {
      await emailService.sendManualCheckNotice(booking.email, booking.fullName, {
        kind, treatment, location: booking.preferredLocation, referenceNumber: booking.referenceNumber, at: new Date(),
      });
    }
  } catch (e) { console.error('⚠️ Manual check email failed:', e.message); }
}

// @desc    Staff send (or resend) the guest's check-in / check-out code by email / WhatsApp
// @route   POST /api/bookings/admin/:id/visit-code
// @access  Private (Admin)
// For guests who don't use the app: the code is the SAME one the app would show,
// so a guest who later opens the app sees the code they were emailed.
exports.sendVisitCodeAdmin = async (req, res) => {
  try {
    const { kind = 'checkin', channel = 'email', regenerate = false } = req.body || {};
    const booking = await Booking.findById(req.params.id).populate('consultationId', 'name');
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });

    const isOut = kind === 'checkout';
    if (isOut && booking.status !== 'In Progress') {
      return res.status(400).json({ success: false, message: 'A check-out code only applies once the guest is checked in.' });
    }
    if (!isOut && !['Confirmed', 'No Show', 'Rescheduled', 'Awaiting Confirmation'].includes(booking.status)) {
      return res.status(400).json({ success: false, message: `Cannot send a check-in code for a booking that is ${booking.status}.` });
    }
    if (regenerate) { booking[isOut ? 'checkOutCode' : 'checkInCode'] = null; }
    const channels = channel === 'both' ? ['email', 'whatsapp'] : [channel];
    const { delivered, failed } = await visitCodes.deliver(booking, kind, { channels, by: req.admin });
    await booking.save();

    res.status(delivered.length ? 200 : 502).json({
      success: delivered.length > 0,
      message: delivered.length
        ? `${isOut ? 'Check-out' : 'Check-in'} code sent by ${delivered.join(' and ')}.`
        : `Could not send the code: ${failed.map((f) => f.reason).join('; ')}`,
      data: { kind: isOut ? 'checkout' : 'checkin', delivered, failed, sentAt: new Date(), log: booking.visitCodeLog },
    });
  } catch (error) {
    console.error('❌ Send visit code failed:', error);
    res.status(500).json({ success: false, message: 'Failed to send the visit code' });
  }
};

// @desc    Reveal the current code to an admin (support fallback; audited)
// @route   GET /api/bookings/admin/:id/visit-code
exports.revealVisitCodeAdmin = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id).select('status checkInCode checkInCodeAt checkInCodeSentAt checkOutCode checkOutCodeAt checkOutCodeSentAt');
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
    const kind = booking.status === 'In Progress' ? 'checkout' : 'checkin';
    const { code } = visitCodes.ensureCode(booking, kind);
    if (booking.isModified()) await booking.save();
    res.json({ success: true, data: { kind, code, generatedAt: kind === 'checkout' ? booking.checkOutCodeAt : booking.checkInCodeAt, sentAt: kind === 'checkout' ? booking.checkOutCodeSentAt : booking.checkInCodeSentAt } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to read the visit code' });
  }
};

/**
 * Put a dermatologist on the booking — from the roster (specialistId) or a
 * custom name. Used before a session starts so every visit is attributed.
 */
async function applyDermatologist(booking, body) {
  if (!body) return false;
  const id = body.specialistId && String(body.specialistId).trim();
  const custom = body.specialistName && String(body.specialistName).trim();
  if (id) {
    const doc = await Doctor.findOne({ $or: [{ doctorId: id.toLowerCase() }, ...(mongoose.Types.ObjectId.isValid(id) ? [{ _id: id }] : [])] }).select('doctorId name tier').lean();
    if (!doc) { const err = new Error('Dermatologist not found'); err.status = 404; throw err; }
    booking.specialistId = doc.doctorId;
    booking.specialistName = doc.name;
    booking.specialistTier = doc.tier === 'senior-consultant' ? 'Senior Dermatologist' : 'Dermatologist';
    return true;
  }
  if (custom) {
    booking.specialistId = null;
    booking.specialistName = custom;
    booking.specialistTier = body.specialistTier || booking.specialistTier || null;
    return true;
  }
  return false;
}
exports.applyDermatologist = applyDermatologist;

// @desc    Assign / change the dermatologist on a booking (roster or custom name)
// @route   PUT /api/bookings/admin/:id/dermatologist
exports.setDermatologistAdmin = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
    const changed = await applyDermatologist(booking, req.body);
    if (!changed) return res.status(400).json({ success: false, message: 'Pick a dermatologist from the list or enter a name.' });
    await booking.save();
    res.json({ success: true, data: booking });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, message: error.message || 'Failed to assign the dermatologist' });
  }
};

// @desc    Assign (or clear) the therapist who will run this session
// @route   PUT /api/bookings/admin/:id/therapist
// @access  Staff (audited)
exports.setTherapistAdmin = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });

    const { therapistAdminId, clear } = req.body || {};
    if (clear) {
      booking.assignedTherapistId = null;
      booking.assignedTherapistName = null;
    } else if (therapistAdminId) {
      const Admin = require('../models/Admin');
      const therapist = await Admin.findOne({ _id: therapistAdminId, role: 'therapist', isActive: true }).lean();
      if (!therapist) return res.status(400).json({ success: false, message: 'Pick an active therapist from the list.' });
      booking.assignedTherapistId = therapist._id;
      booking.assignedTherapistName = therapist.name;
    } else {
      return res.status(400).json({ success: false, message: 'Pick a therapist, or clear the assignment.' });
    }
    await booking.save();
    return res.json({ success: true, data: booking });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message || 'Failed to assign the therapist' });
  }
};

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
      // Normally already issued + sent at check-in; mint one here if not.
      const { fresh } = visitCodes.ensureCode(booking, 'checkout');
      if (fresh) { await visitCodes.deliver(booking, 'checkout', { by: null }); }
      if (booking.isModified()) await booking.save();
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

    const { fresh } = visitCodes.ensureCode(booking, 'checkin');
    if (fresh) { await visitCodes.deliver(booking, 'checkin', { by: null }); }
    if (booking.isModified()) await booking.save();
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

    await applyDermatologist(booking, req.body);
    booking.status = 'In Progress';
    booking.checkInTime = new Date();
    booking.checkInCode = null;
    booking.checkInCodeAt = null;
    await booking.populate('consultationId', 'name');
    // The session has started: issue the check-out code now and send it, so a
    // guest without the app already has it when the treatment ends.
    await visitCodes.deliver(booking, 'checkout', { by: req.admin });
    booking.$locals.zenotiStaffAction = true; // a person at the desk decided this
    await booking.save();

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
    booking.$locals.zenotiStaffAction = true; // a person at the desk decided this
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

    // Zenoti-booked: the diary of record is Zenoti. Cancel / reschedule /
    // no-show are done there, always; only attendance is recorded here.
    if (booking.source === 'zenoti') {
      return res.status(409).json({
        success: false,
        code: 'ZENOTI_OWNED_APPOINTMENT',
        message: 'This appointment was booked in Zenoti. Cancel or reschedule it in Zenoti — the change appears here within 2 minutes. Check-in, check-out, completion and no-show can be recorded here.'
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

    booking.$locals.zenotiStaffAction = true; // a person at the desk decided this
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
    const allSlots = branch ? branch.getAvailableSlots(clinicDayStart(date)) : [];

    // Get bookings for the date and location
    const startDate = clinicDayStart(date);
    const endDate = clinicDayEnd(date);

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
        dateOfBirth: req.body.dateOfBirth || undefined,
        gender: req.body.gender || undefined,
        source: 'reception',
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

    // Reception booking a dermatologist onto a held slot is the same clash the
    // app is protected against. Only a genuine double-booking blocks; other
    // diary states (lead time, leave) stay overridable at the front desk.
    if (specialistId && confirmNow && slots[0]) {
      const { isSlotBookable } = require('../utils/dermatologistSlots');
      const key = clinicDateKey(preferredDate);
      const check = key
        ? await isSlotBookable(specialistId, key, slots[0], { branchId: branch._id })
        : { ok: true };
      if (!check.ok && check.reason === 'already-booked') {
        return res.status(409).json({
          success: false,
          code: 'DERMATOLOGIST_SLOT_UNAVAILABLE',
          message: 'Another guest already holds that time with this dermatologist. Pick a different slot.',
        });
      }
    }

    const booking = new Booking({
      userId: user._id,
      consultationId,
      fullName,
      mobileNumber,
      email: user.email,
      branchId: branch._id,
      preferredLocation,
      preferredDate: clinicDayStart(preferredDate),
      preferredTimeSlots: slots,
      slotTime: specialistId && confirmNow ? slots[0] : undefined,
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
      booking.confirmedDate = clinicDayStart(preferredDate);
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

    // Zenoti-booked: the diary of record is Zenoti. Cancel / reschedule /
    // no-show are done there, always; only attendance is recorded here.
    if (booking.source === 'zenoti') {
      return res.status(409).json({
        success: false,
        code: 'ZENOTI_OWNED_APPOINTMENT',
        message: 'This appointment was booked in Zenoti. Cancel or reschedule it in Zenoti — the change appears here within 2 minutes. Check-in, check-out, completion and no-show can be recorded here.'
      });
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

    // Moving a dermatologist consultation must not land on a slot another
    // guest already holds. Excluding this booking lets it keep (or reclaim)
    // its own time; other diary problems (leave, outside hours) stay a staff
    // judgement call rather than a hard block.
    if (booking.specialistId && confirmedTime) {
      const { isSlotBookable } = require('../utils/dermatologistSlots');
      const key = clinicDateKey(preferredDate);
      const check = key
        ? await isSlotBookable(booking.specialistId, key, confirmedTime, {
            branchId: booking.branchId || null,
            excludeBookingId: booking._id,
          })
        : { ok: true };
      if (!check.ok && check.reason === 'already-booked') {
        return res.status(409).json({
          success: false,
          code: 'DERMATOLOGIST_SLOT_UNAVAILABLE',
          message: 'Another guest already holds that time with this dermatologist. Pick a different slot.',
        });
      }
    }

    booking.rescheduledFrom = {
      date: booking.confirmedDate || booking.preferredDate,
      time: booking.confirmedTime || booking.preferredTimeSlots?.[0],
    };
    booking.rescheduledAt = new Date();
    booking.preferredDate = clinicDayStart(preferredDate);
    if (Array.isArray(preferredTimeSlots) && preferredTimeSlots.length) {
      booking.preferredTimeSlots = preferredTimeSlots;
    }
    if (confirmedTime) {
      booking.confirmedDate = clinicDayStart(preferredDate);
      booking.confirmedTime = confirmedTime;
      booking.status = 'Confirmed';
    } else {
      booking.status = 'Rescheduled';
      booking.confirmedDate = undefined;
      booking.confirmedTime = undefined;
    }
    // The diary reads slotTime first — a stale value would keep holding the
    // old time while leaving the new one visibly free.
    if (booking.slotTime) booking.slotTime = confirmedTime || null;
    if (reason) {
      booking.adminNotes = `${booking.adminNotes ? `${booking.adminNotes}\n` : ''}Rescheduled: ${reason}`;
    }

    booking.$locals.zenotiStaffAction = true; // a person at the desk decided this
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

// @desc    Re-read one Zenoti-linked booking from Zenoti now and reconcile it
// @route   POST /api/bookings/admin/:id/zenoti-refresh
// @access  Private (Admin)
exports.refreshFromZenotiAdmin = async (req, res) => {
  try {
    const { refreshAppointment } = require('../services/zenotiAppointmentSyncService');
    const { booking, result } = await refreshAppointment(req.params.id);
    res.status(200).json({ success: true, message: `Refreshed from Zenoti (${result.outcome}).`, data: booking });
  } catch (error) {
    res.status(error.status || 502).json({ success: false, message: error.message || 'Could not refresh from Zenoti.' });
  }
};

// @desc    Push this booking to Zenoti now: create the appointment if it has
//          none, otherwise write its current desk state (a staff action).
// @route   POST /api/bookings/admin/:id/zenoti-push
// @access  Private (Admin)
exports.pushToZenotiAdmin = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id).select('zenotiAppointmentId zenotiInvoiceId source');
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
    if (booking.zenotiAppointmentId || booking.zenotiInvoiceId) await zenotiWrite.syncBookingState(booking._id, { staffAction: true });
    else if (booking.source === 'zenoti') return res.status(400).json({ success: false, message: 'This appointment already lives in Zenoti.' });
    else await zenotiWrite.syncBooking(booking._id);
    const fresh = await Booking.findById(booking._id)
      .populate('consultationId', 'name category price image').populate('userId', 'fullName email phone patientId').lean();
    const ok = fresh.zenotiSyncStatus === 'synced';
    res.status(200).json({ success: ok, message: ok ? 'Written to Zenoti.' : (fresh.zenotiSyncError || `Zenoti write ${fresh.zenotiSyncStatus || 'not performed'} (mode ${zenotiWrite.mode()}).`), data: fresh });
  } catch (error) {
    res.status(502).json({ success: false, message: error.message || 'Could not write to Zenoti.' });
  }
};
