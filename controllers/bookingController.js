const mongoose = require('mongoose');
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
const lifecycle = require('../services/bookingLifecycleService');
const Doctor = require('../models/Doctor');
const Consultation = require('../models/Consultation');
const User = require('../models/User');
const Branch = require('../models/Branch');
const PackageAssignment = require('../models/PackageAssignment');
const guestMessaging = require('../utils/guestMessaging');
const emailService = require('../utils/emailService');
const NotificationHelper = require('../utils/notificationHelper');
const whatsappService = require('../services/whatsappService');
const twilioVoiceService = require('../services/twilioVoiceService');
const {
  bookingScheduledAt, clinicDateKey, clinicDayEnd, clinicDayStart, formatClinicDate, formatClinicDateTime,
} = require('../utils/bookingTime');
const { UPCOMING: BOOKING_UPCOMING, PAST: BOOKING_PAST } = require('../utils/bookingStatuses');
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

    // A new guest's first appointment is a dermatologist consultation; the app
    // hides treatment booking for them, and this enforces it for any client.
    const gate = await require('../utils/guestEligibility').serviceBookingBlock(req.user._id, consultation);
    if (gate) return res.status(gate.status).json({ success: false, code: gate.code, message: gate.message });

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
          preferredDate: booking.preferredDate.toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
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
      if (!(await guestMessaging.shouldSendBookingWhatsApp(booking, 'confirmation')).ok) throw Object.assign(new Error('suppressed: Zenoti sends guest messages for this centre'), { suppressed: true });
      await whatsappService.sendBookingConfirmation(
        booking.mobileNumber,
        {
          patientName: booking.fullName,
          referenceNumber: booking.referenceNumber,
          treatment: consultation.name,
          date: booking.preferredDate.toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
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
      const formattedDate = booking.preferredDate.toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      
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
      query.status = { $in: BOOKING_UPCOMING };
    } else if (upcoming === 'false') {
      query.status = { $in: BOOKING_PAST };
    }

    // Newest appointment first. `createdAt` was wrong for the patient's own
    // history: a Zenoti visit from 2024 imported last week would have sorted
    // above an appointment they booked in the app this morning.
    const bookings = await Booking.find(query)
      .populate('consultationId', 'name category price image duration_minutes')
      .sort({ eventAt: -1, _id: -1 })
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
          date: booking.preferredDate.toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
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
      if (!(await guestMessaging.shouldSendBookingWhatsApp(booking, 'cancelled')).ok) throw Object.assign(new Error('suppressed: Zenoti sends guest messages for this centre'), { suppressed: true });
      await whatsappService.sendAppointmentCancelled(
        booking.mobileNumber,
        {
          patientName: booking.fullName,
          referenceNumber: booking.referenceNumber,
          treatment: booking.consultationId.name,
          date: booking.preferredDate.toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
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
  /*
   * Guests no longer reschedule from the app.
   *
   * A dermatologist's diary is the clinic's to arrange: a guest moving their
   * own slot could take a time the desk had held, and a consultation that has
   * already been paid for must not drift without someone at the desk seeing
   * it. Reception reschedules from the panel instead, with a reason the guest
   * then sees on the booking.
   *
   * The route stays (rather than being deleted) so app builds that still show
   * the old button get this explanation instead of a 404.
   */
  try {
    const booking = await Booking.findOne({ _id: req.params.id, userId: req.user._id })
      .select('branchId')
      .populate('branchId', 'name contact');
    const phone = booking?.branchId?.contact?.phone?.[0]?.number
      || booking?.branchId?.contact?.phone?.[0]
      || null;
    return res.status(409).json({
      success: false,
      code: 'RESCHEDULE_AT_CLINIC',
      message: phone
        ? `To move this appointment, please call the clinic on ${phone} and we will find you a new time.`
        : 'To move this appointment, please call the clinic and we will find you a new time.',
      data: { clinicPhone: phone, branchName: booking?.branchId?.name || null },
    });
  } catch (error) {
    return res.status(409).json({
      success: false,
      code: 'RESCHEDULE_AT_CLINIC',
      message: 'To move this appointment, please call the clinic and we will find you a new time.',
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
    booking.$locals.zenotiStaffAction = true; // the desk declined the change — a person decided
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

/*
 * Self check-in / check-out from the app were removed on 2026-09-07.
 *
 * Attendance is a fact the clinic observes, not something a guest can assert
 * from anywhere with a phone — and it now has to match Zenoti, where only the
 * desk moves an appointment. The routes answer 410 (see routes/booking.js).
 */

// @desc    Rate booking// @desc    Rate booking
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

    const from = booking.status;
    booking.status = 'Confirmed';
    booking.confirmedDate = clinicDayStart(confirmedDate);
    booking.confirmedTime = confirmedTime;
    // Keep the diary's primary field in step for calendar-booked consults.
    if (booking.slotTime) booking.slotTime = confirmedTime || booking.slotTime;

    lifecycle.logStatus(booking, { action: 'confirm', from, to: 'Confirmed', admin: req.admin });
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
          confirmedDate: booking.confirmedDate.toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
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
      if (!(await guestMessaging.shouldSendBookingWhatsApp(booking, 'confirmation')).ok) throw Object.assign(new Error('suppressed: Zenoti sends guest messages for this centre'), { suppressed: true });
      await whatsappService.sendAppointmentConfirmed(
        booking.mobileNumber,
        {
          patientName: booking.fullName,
          referenceNumber: booking.referenceNumber,
          treatment: booking.consultationId.name,
          confirmedDate: booking.confirmedDate.toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
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
    // Transition, Zenoti push and audit trail all live in one place.
    await lifecycle.apply(booking, 'no_show', { admin: req.admin, reason: req.body?.reason, via: 'panel' });

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
          date: booking.confirmedDate?.toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) || booking.preferredDate.toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
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
      if (!(await guestMessaging.shouldSendBookingWhatsApp(booking, 'noshow')).ok) throw Object.assign(new Error('suppressed: Zenoti sends guest messages for this centre'), { suppressed: true });
      await whatsappService.sendNoShowNotification(
        booking.mobileNumber,
        {
          patientName: booking.fullName,
          treatment: booking.consultationId.name,
          date: booking.confirmedDate?.toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) || booking.preferredDate.toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
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
    if (error.name === 'LifecycleError') {
      return res.status(error.status).json({ success: false, code: error.code, message: error.message, meta: error.meta });
    }
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

/* ===========================================================================
 * Appointment lifecycle — the desk's actions, mirroring Zenoti's own
 * appointment book: check in, undo check-in, start, undo start, complete,
 * reopen, no show, cancel and their undos.
 *
 * Every one of them goes through services/bookingLifecycleService, which owns
 * the legal transitions, the check-in time window and the Zenoti push. These
 * handlers only translate HTTP to that call and send the guest's notifications.
 * ======================================================================== */

/**
 * Tell the guest what just happened to their appointment.
 *
 * In-app notification always; email and WhatsApp only for the two moments
 * worth interrupting someone for (they are here, and they are done). An undo
 * is a desk correction, so it updates the app silently rather than sending
 * "your session has started" twice.
 */
async function notifyLifecycle(booking, action) {
  const treatment = (booking.consultationId && booking.consultationId.name)
    || booking.externalServiceName || 'your appointment';
  const time = booking.confirmedTime || booking.slotTime || (booking.preferredTimeSlots || [])[0];
  const dateLabel = formatClinicDate(booking.confirmedDate || booking.preferredDate);

  const inApp = {
    check_in: ['Checked in', `You're checked in for ${treatment}. Please take a seat — we'll call you shortly.`],
    undo_check_in: ['Check-in reversed', `Reception reversed the check-in for ${treatment}.`],
    start: ['Session started', `Your ${treatment} session has started.`],
    undo_start: ['Session start reversed', `Reception reversed the start of your ${treatment} session.`],
    complete: ['Visit complete', `Your ${treatment} visit is complete. Thank you for visiting Zennara.`],
    undo_complete: ['Visit reopened', `Reception reopened your ${treatment} visit.`],
    no_show: ['Marked as no show', `You were marked absent for ${treatment} on ${dateLabel}.`],
    undo_no_show: ['No show reversed', `The no-show on your ${treatment} appointment was reversed.`],
  }[action];

  if (inApp && booking.userId) {
    try {
      await NotificationHelper.create({
        userId: booking.userId,
        type: 'booking',
        title: inApp[0],
        message: `${inApp[1]}${booking.preferredLocation ? ` · ${booking.preferredLocation}` : ''}`,
        relatedId: booking._id,
        relatedModel: 'Booking',
        priority: action === 'complete' ? 'high' : 'medium',
      });
    } catch (e) { console.error('⚠️ lifecycle notification failed:', e.message); }
  }

  if (action === 'check_in') {
    try {
      await NotificationHelper.bookingCheckedIn({
        _id: booking._id, patientName: booking.fullName,
        consultation: { name: treatment }, checkInTime: booking.checkInTime,
      });
    } catch (e) { console.error('⚠️ check-in staff notification failed:', e.message); }
    try {
      if (!isPlaceholderEmail(booking.email)) {
        await emailService.sendCheckInSuccessful(booking.email, booking.fullName, {
          treatment, time, location: booking.preferredLocation, waitTime: '5-10',
        }, booking.preferredLocation);
      }
    } catch (e) { console.error('⚠️ check-in email failed:', e.message); }
    try {
      if ((await guestMessaging.shouldSendBookingWhatsApp(booking, 'checkin')).ok) {
        await whatsappService.sendCheckInSuccessful(booking.mobileNumber, {
          patientName: booking.fullName, treatment, time,
          location: booking.preferredLocation, waitTime: '5-10',
        });
      }
    } catch (e) { console.error('⚠️ check-in WhatsApp failed:', e.message); }
  }

  if (action === 'complete') {
    try {
      await NotificationHelper.bookingCompleted({
        _id: booking._id, userId: booking.userId, patientName: booking.fullName,
        consultation: { name: treatment }, checkOutTime: booking.checkOutTime,
      });
    } catch (e) { console.error('⚠️ completion staff notification failed:', e.message); }
    try {
      if (!isPlaceholderEmail(booking.email)) {
        await emailService.sendAppointmentCompleted(booking.email, booking.fullName, {
          treatment, date: dateLabel, location: booking.preferredLocation,
        }, booking.preferredLocation);
      }
    } catch (e) { console.error('⚠️ completion email failed:', e.message); }
    try {
      if ((await guestMessaging.shouldSendBookingWhatsApp(booking, 'completed')).ok) {
        await whatsappService.sendAppointmentCompleted(booking.mobileNumber, {
          patientName: booking.fullName, treatment, date: dateLabel,
          location: booking.preferredLocation, sessionDuration: booking.sessionDuration,
          bookingId: booking._id,
        });
      }
    } catch (e) { console.error('⚠️ completion WhatsApp failed:', e.message); }
  }
}

/** Human wording for the result line the panel shows after an action. */
const LIFECYCLE_DONE = {
  check_in: 'Guest checked in',
  undo_check_in: 'Check-in reversed',
  start: 'Session started',
  undo_start: 'Start reversed — the guest is checked in',
  complete: 'Session completed',
  undo_complete: 'Session reopened',
  no_show: 'Marked as no show',
  undo_no_show: 'No show reversed',
  cancel: 'Appointment cancelled',
  undo_cancel: 'Cancellation reversed',
  confirm: 'Appointment confirmed',
};

/**
 * Run one lifecycle action.
 *
 * @route POST /api/bookings/admin/:id/lifecycle
 * body: { action, reason?, force?, specialistId?/specialistName?, session? }
 */
exports.bookingLifecycleAdmin = async (req, res) => {
  const action = String(req.body?.action || '').trim();
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });

    // A booking cannot leave the desk confirmed with nobody assigned to it.
    // Answered with a code so the panel can open the picker rather than just
    // showing an error; a Zenoti-owned visit is Zenoti's to staff.
    if (action === 'confirm' && booking.source !== 'zenoti') {
      const willHave = req.body?.specialistId || req.body?.specialistName
        || booking.specialistName || booking.specialistId || booking.therapistName;
      if (!willHave) {
        return res.status(400).json({
          success: false,
          code: 'DERMATOLOGIST_REQUIRED',
          message: 'Choose who is running this appointment before confirming it.',
        });
      }
    }

    await lifecycle.apply(booking, action, {
      admin: req.admin,
      reason: req.body?.reason,
      force: req.body?.force === true || req.body?.force === 'true',
      via: 'panel',
      // Attribution and the session write-up belong to the transition that
      // carries them: who ran it (set at check-in / start) and what was used
      // (recorded at completion).
      mutate: async (doc) => {
        /*
         * Confirming is where a treatment gets its dermatologist.
         *
         * A consultation carries one from the moment it is booked — the guest
         * picks the specialist in the app. A TREATMENT does not: the app asks
         * for a service, a date and a time, and nothing else. So a confirmed
         * treatment used to sit in the diary with nobody assigned to it, and
         * the gap was only noticed at check-in. The desk decides who is running
         * it at the moment it says yes to the slot, so that is where it is
         * asked for.
         */
        if (['confirm', 'check_in', 'start'].includes(action)) await applyDermatologist(doc, req.body);
        if (action === 'complete') applySessionFromBody(doc, req);
      },
    });

    await booking.populate('consultationId', 'name category price image');
    await notifyLifecycle(booking, action);

    return res.status(200).json({
      success: true,
      message: LIFECYCLE_DONE[action] || 'Appointment updated',
      data: booking,
      meta: lifecycle.lifecycleState(booking),
    });
  } catch (error) {
    if (error.name === 'LifecycleError') {
      return res.status(error.status).json({
        success: false, code: error.code, message: error.message, meta: error.meta,
      });
    }
    console.error('❌ Booking lifecycle error:', error);
    return res.status(error.status || 500).json({ success: false, message: error.message || 'Failed to update the appointment' });
  }
};

/** Legacy route names kept so older panel builds keep working. */
const lifecycleAlias = (action) => (req, res) => {
  req.body = { ...(req.body || {}), action };
  return exports.bookingLifecycleAdmin(req, res);
};
// PUT /api/bookings/admin/:id/checkin
exports.checkInBookingAdmin = lifecycleAlias('check_in');
// PUT /api/bookings/admin/:id/checkout — "check out" is Zenoti's "close the
// service"; the desk-facing word for it is now Complete.
exports.checkOutBookingAdmin = lifecycleAlias('complete');

/**
 * What this booking can do right now — the panel renders its action bar from
 * this rather than re-deriving the rules in TypeScript.
 * @route GET /api/bookings/admin/:id/lifecycle
 */
exports.getBookingLifecycleAdmin = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id).select('status source confirmedDate confirmedTime preferredDate preferredTimeSlots slotTime statusLog checkInTime checkOutTime');
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });
    return res.json({ success: true, data: { ...lifecycle.lifecycleState(booking), statusLog: booking.statusLog } });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to read the appointment lifecycle' });
  }
};

/**
 * Put a dermatologist on the booking/**
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

/*
 * The visit-code (OTP) check-in was removed on 2026-09-07.
 *
 * It asked the guest to read a 6-digit code to reception, which Zenoti has no
 * concept of: the code lived only in our database, so a check-in done at the
 * desk in Zenoti and one done here could not be told apart, and the app kept
 * showing a code for a visit Zenoti had already closed. Attendance is now the
 * lifecycle above, in the same shape Zenoti uses. The old routes answer 410.
 */

// @desc    Cancel booking (Admin)// @desc    Cancel booking (Admin)
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

    booking.cancelledBy = 'admin';
    await lifecycle.apply(booking, 'cancel', {
      admin: req.admin,
      reason: reason || 'Cancelled by admin',
      via: 'panel',
    });

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
          date: (booking.confirmedDate || booking.preferredDate).toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
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
      if (!(await guestMessaging.shouldSendBookingWhatsApp(booking, 'cancelled')).ok) throw Object.assign(new Error('suppressed: Zenoti sends guest messages for this centre'), { suppressed: true });
      await whatsappService.sendAppointmentCancelled(
        booking.mobileNumber,
        {
          patientName: booking.fullName,
          referenceNumber: booking.referenceNumber,
          treatment: booking.consultationId.name,
          date: (booking.confirmedDate || booking.preferredDate).toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
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
    if (error.name === 'LifecycleError') {
      return res.status(error.status).json({ success: false, code: error.code, message: error.message, meta: error.meta });
    }
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
      // Desk parity with Zenoti's New Appointment panel:
      services,          // [{ consultationId, specialistId, specialistName, specialistTier, time, amount, packageAssignmentId, packageSessionId }] — one visit, several rows
      force,             // true = the desk saw "not working at this time" and chose Yes
      referralSource,    // asked once for a brand-new guest
      referredByUserId,
      packageAssignmentId, // book from the guest's package balance
      packageSessionId,
    } = req.body;

    const lines = Array.isArray(services) && services.length
      ? services
      : [{ consultationId, specialistId, specialistName, specialistTier, amount, time: (Array.isArray(preferredTimeSlots) && preferredTimeSlots[0]) || req.body.confirmedTime, packageAssignmentId, packageSessionId }];

    if (!lines[0]?.consultationId || !fullName || !mobileNumber || !preferredLocation || !preferredDate) {
      return res.status(400).json({
        success: false,
        message: 'consultationId, fullName, mobileNumber, preferredLocation and preferredDate are required',
      });
    }

    const branch = await Branch.findOne({ name: preferredLocation, isActive: true });
    if (!branch) {
      return res.status(404).json({ success: false, message: 'Branch not found or inactive' });
    }

    // Every service must exist before anything is written.
    const consultations = new Map();
    for (const line of lines) {
      if (!line.consultationId) return res.status(400).json({ success: false, message: 'Every service line needs a consultationId' });
      if (!consultations.has(String(line.consultationId))) {
        const c = await Consultation.findById(line.consultationId);
        if (!c) return res.status(404).json({ success: false, message: 'Service not found' });
        consultations.set(String(line.consultationId), c);
      }
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
        referralSource: referralSource ? String(referralSource).trim() : null,
        referredByUserId: referredByUserId || null,
        source: 'reception',
        isVerified: false,
        isActive: true,
      });
      createdUser = true;
    } else if (referralSource && !user.referralSource) {
      // First time the desk records how an existing guest found us.
      await User.updateOne({ _id: user._id }, { $set: { referralSource: String(referralSource).trim(), ...(referredByUserId ? { referredByUserId } : {}) } }).catch(() => {});
    }

    const { isSlotBookable } = require('../utils/dermatologistSlots');
    const key = clinicDateKey(preferredDate);
    const visitGroupId = lines.length > 1 ? `VG${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}` : null;

    // Validate every line first so a multi-service visit is all-or-nothing.
    const prepared = [];
    for (const line of lines) {
      const consultation = consultations.get(String(line.consultationId));
      const slots = line.time ? [line.time]
        : (Array.isArray(preferredTimeSlots) && preferredTimeSlots.length ? preferredTimeSlots : [req.body.confirmedTime].filter(Boolean));
      if (!slots.length) {
        return res.status(400).json({ success: false, message: 'At least one preferred time slot is required' });
      }
      const lineSpecialistId = line.specialistId || null;
      if (lineSpecialistId && confirmNow && slots[0] && key) {
        // A genuine double-booking always blocks. Any other diary problem
        // (not on shift, leave, outside centre hours, too soon) is reported
        // once so the desk can say Yes/No — Zenoti's "not working at the
        // mentioned time. Do you want to add the appointment?"
        const check = await isSlotBookable(lineSpecialistId, key, slots[0], { branchId: branch._id });
        if (!check.ok && check.reason === 'already-booked') {
          return res.status(409).json({
            success: false,
            code: 'DERMATOLOGIST_SLOT_UNAVAILABLE',
            message: `Another guest already holds ${slots[0]} with this dermatologist. Pick a different slot.`,
          });
        }
        if (!check.ok && !force) {
          const why = {
            'not-working': 'is not working at the mentioned time',
            'not-configured': 'has no working hours set up',
            'not-at-this-centre': 'is not rostered at this centre on that day',
            'centre-closed': 'cannot be booked because the centre is closed that day',
            'outside-centre-hours': 'is outside the centre\'s hours at that time',
            'too-soon': 'is inside the booking lead time',
            'past': 'cannot be booked in the past',
            'beyond-horizon': 'is beyond the booking horizon',
            'no-such-slot': 'has no slot at that exact time',
            'doctor-inactive': 'is not listed',
            'inactive': 'has online booking switched off',
          }[check.reason] || `cannot take ${slots[0]} (${check.reason})`;
          return res.status(409).json({
            success: false,
            code: 'PROVIDER_NOT_WORKING',
            reason: check.reason,
            message: `${line.specialistName || specialistName || 'This dermatologist'} ${why}. Do you want to add the appointment anyway?`,
          });
        }
      }

      // Book from the guest's package balance: the session is redeemed, nothing is charged.
      let assignment = null; let session = null;
      if (line.packageAssignmentId && line.packageSessionId) {
        assignment = await PackageAssignment.findOne({ _id: line.packageAssignmentId, userId: user._id });
        if (!assignment) return res.status(404).json({ success: false, message: 'That package does not belong to this guest' });
        { const rd = assignment.redeemable({ branchId: branch._id }); if (!rd.ok) return res.status(409).json({ success: false, code: rd.code, message: rd.message }); }
        session = assignment.sessions.id(line.packageSessionId);
        if (!session) return res.status(404).json({ success: false, message: 'Package session not found' });
        if (session.bookingId || ['Booked', 'Completed', 'Cancelled'].includes(session.status)) return res.status(409).json({ success: false, message: 'That package session already has an appointment' });
      }

      const priced = typeof consultation.priceAt === 'function' ? consultation.priceAt(branch._id) : { total: consultation.price };
      const lineAmount = assignment ? 0
        : line.amount !== undefined && line.amount !== null ? Number(line.amount)
        : amount !== undefined && amount !== null && lines.length === 1 ? Number(amount)
        : priced.total;
      prepared.push({ line, consultation, slots, assignment, session, lineAmount, lineSpecialistId });
    }

    const created = [];
    for (const { line, consultation, slots, assignment, session, lineAmount, lineSpecialistId } of prepared) {
      const booking = new Booking({
        userId: user._id,
        consultationId: consultation._id,
        visitGroupId,
        fullName,
        mobileNumber,
        email: user.email,
        branchId: branch._id,
        preferredLocation,
        preferredDate: clinicDayStart(preferredDate),
        preferredTimeSlots: slots,
        slotTime: lineSpecialistId && confirmNow ? slots[0] : undefined,
        specialistId: lineSpecialistId || undefined,
        specialistName: line.specialistName || (lineSpecialistId ? specialistName : undefined) || undefined,
        specialistTier: line.specialistTier || (lineSpecialistId ? specialistTier : undefined) || undefined,
        amount: lineAmount,
        paymentStatus: assignment ? 'paid' : (paymentStatus || 'pending'),
        paymentMethod: assignment ? 'Package' : undefined,
        isPackageIncluded: Boolean(assignment),
        packageAssignmentId: assignment ? assignment._id : undefined,
        packageSessionId: session ? session._id : undefined,
        status: confirmNow ? 'Confirmed' : 'Awaiting Confirmation',
        notes: notes || undefined,
        source: 'reception',
        adminNotes: `Created at reception by ${req.admin?.email || 'admin'}${force ? ' (outside working hours, confirmed by desk)' : ''}`,
      });
      if (confirmNow) {
        booking.confirmedDate = clinicDayStart(preferredDate);
        booking.confirmedTime = slots[0];
      }
      await booking.save();
      if (assignment && session) {
        session.bookingId = booking._id;
        session.bookingCreatedAt = new Date();
        session.status = 'Booked';
        session.scheduledDate = clinicDayStart(preferredDate);
        session.scheduledTime = slots[0];
        if (lineSpecialistId) { session.specialistId = lineSpecialistId; session.specialistName = line.specialistName || null; }
        await assignment.save();
      }
      created.push({ booking, consultation });
    }

    const [{ booking, consultation }] = created;
    await booking.populate('consultationId', 'name category price image');
    await booking.populate('userId', 'fullName email phone patientId');

    try {
      await NotificationHelper.bookingCreated({
        _id: booking._id,
        userId: booking.userId._id || booking.userId,
        patientName: booking.fullName,
        consultation: { name: created.map((c) => c.consultation.name).join(' + ') },
        branch: { name: branch.name },
        appointmentDate: booking.preferredDate,
      });
    } catch (notifError) {
      console.error('⚠️ Failed to create notification:', notifError.message);
    }

    // Best-effort confirmations — a messaging outage must not lose the booking.
    const treatmentLabel = created.map((c) => c.consultation.name).join(' + ');
    try {
      if (!(await guestMessaging.shouldSendBookingWhatsApp(booking, 'confirmation')).ok) throw Object.assign(new Error('suppressed: Zenoti sends guest messages for this centre'), { suppressed: true });
      await whatsappService.sendBookingConfirmation(booking.mobileNumber, {
        patientName: booking.fullName,
        referenceNumber: booking.referenceNumber,
        treatment: treatmentLabel,
        date: booking.preferredDate.toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
        timeSlots: created.map((c) => c.booking.preferredTimeSlots[0]).join(', '),
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
            treatment: treatmentLabel,
            category: consultation.category,
            preferredDate: booking.preferredDate.toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
            timeSlots: created.map((c) => c.booking.preferredTimeSlots[0]).join(', '),
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
        : created.length > 1 ? `${created.length} services booked for ${fullName}.` : 'Booking created successfully',
      data: booking,
      bookings: created.map((c) => c.booking),
      meta: { createdUser, patientId: user.patientId, visitGroupId },
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
      // The guest sees this in the app, so it travels on the booking rather
      // than only in the internal notes.
      reason: reason || undefined,
      by: 'clinic',
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

/**
 * PATCH /api/bookings/admin/:id/stage — move a consultation through its
 * clinical lifecycle.
 *
 * Separate from the booking-status endpoints on purpose (see
 * Booking.consultationStage): this never touches `status`, so it can never
 * disturb the diary, the slot engine or the Zenoti mirror. It records who made
 * the change, which matters for a clinical record.
 *
 * The follow-up decision is captured here too, because "consultation complete,
 * follow-up in six weeks" is one action for the dermatologist, not two.
 */
exports.updateConsultationStage = async (req, res) => {
  try {
    const { stage, followUp } = req.body || {};
    const allowed = Booking.schema.path('consultationStage').enumValues;
    if (stage !== undefined && stage !== null && !allowed.includes(stage)) {
      return res.status(400).json({
        success: false,
        message: `Unknown consultation stage. Expected one of: ${allowed.join(', ')}`,
      });
    }

    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ success: false, message: 'Appointment not found' });

    if (stage !== undefined) {
      booking.consultationStage = stage;
      booking.consultationStageHistory.push({
        stage,
        at: new Date(),
        by: req.admin?._id || null,
        byName: req.admin?.name || '',
      });
    }

    if (followUp && typeof followUp === 'object') {
      booking.followUp = {
        ...(booking.followUp ? booking.followUp.toObject?.() ?? booking.followUp : {}),
        ...(followUp.required !== undefined ? { required: Boolean(followUp.required) } : {}),
        ...(followUp.dueDate !== undefined ? { dueDate: followUp.dueDate ? new Date(followUp.dueDate) : null } : {}),
        ...(followUp.notes !== undefined ? { notes: String(followUp.notes || '').slice(0, 1000) } : {}),
      };
    }

    // The clinical stage is not an operational change, so the Zenoti
    // write-back hooks stay out of it (they key off status/date/time only).
    await booking.save({ validateModifiedOnly: true });

    return res.json({
      success: true,
      data: {
        _id: booking._id,
        consultationStage: booking.consultationStage,
        followUp: booking.followUp,
      },
    });
  } catch (error) {
    console.error('updateConsultationStage failed:', error);
    return res.status(500).json({ success: false, message: 'Could not update the consultation stage' });
  }
};

/**
 * Step the last desk decision back.
 *
 * Kept as its own route because the panel's undo button doesn't know (or care)
 * which action it is reversing — it just knows this booking went somewhere it
 * shouldn't have. The reverse action is derived from the current status and
 * then runs through the same validation as any other transition.
 */
const UNDO_FOR_STATUS = {
  'Checked In': 'undo_check_in',
  'In Progress': 'undo_start',
  Completed: 'undo_complete',
  'No Show': 'undo_no_show',
  Cancelled: 'undo_cancel',
};

exports.undoBookingStatusAdmin = async (req, res) => {
  const action = UNDO_FOR_STATUS[String(req.body?.status || '') || ''] || null;
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ success: false, message: 'Booking not found' });

    const undo = action || UNDO_FOR_STATUS[booking.status];
    if (!undo) {
      return res.status(400).json({ success: false, message: `Nothing to undo for a ${booking.status.toLowerCase()} booking.` });
    }

    const from = booking.status;
    await lifecycle.apply(booking, undo, {
      admin: req.admin,
      reason: req.body?.reason,
      via: 'panel',
    });
    await booking.populate('consultationId', 'name category price image');
    await booking.populate('userId', 'fullName email phone patientId');
    await notifyLifecycle(booking, undo);

    return res.json({
      success: true,
      message: `Reverted to ${booking.status}`,
      data: booking,
      meta: { from, to: booking.status, action: undo, ...lifecycle.lifecycleState(booking) },
    });
  } catch (error) {
    if (error.name === 'LifecycleError') {
      return res.status(error.status).json({ success: false, code: error.code, message: error.message, meta: error.meta });
    }
    console.error('Undo booking status error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Failed to undo' });
  }
};
