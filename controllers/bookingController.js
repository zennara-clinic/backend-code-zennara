const mongoose = require('mongoose');
const Booking = require('../models/Booking');

/**
 * A catalogue entry that backs the consultation flow rather than a treatment.
 * Mirrors resolveServiceId's own test, so the booking gate and the Zenoti push
 * agree about which rows have a fallback and which need a real mapping.
 */
const isConsultationEntry = (c) => /^consultations?$/i.test(String(c?.category || '').trim())
  || /consultation/i.test(String(c?.name || ''));
// The paid path (paymentController.createConsultationPayment) has to apply the
// very same "bookable online" gate this file's createBooking applies, so the
// free and paid routes cannot come to different answers about one catalogue
// row. Exported rather than copied for exactly that reason.
exports.isConsultationEntry = isConsultationEntry;
const zenotiWrite = require('../services/zenotiWriteService');

/**
 * A dermatologist login only ever sees its own diary, whatever specialistId it
 * asks for. `ownDiaryParams` drops the specialistId they sent before the
 * filters are built; `scopeToOwnDiary` then adds their real match — profile id
 * or Zenoti employee id (utils/doctorPatients.doctorBookingMatch), so a visit
 * synced from Zenoti before the profile was linked is still theirs.
 */
function ownDiaryParams(req) {
  if (req.admin?.role !== 'doctor' || isGuestHistory(req)) return req.query;
  const { specialistId, ...rest } = req.query || {}; // eslint-disable-line no-unused-vars
  return rest;
}
/**
 * One guest's visit history is clinical context, not someone else's diary: a
 * dermatologist looking up a guest (?userId=) sees every visit that guest has
 * had — treatments by therapists and other dermatologists included. On prod
 * (2026-09-10) the diary scope hid those for 173 of 343 sampled guests.
 */
function isGuestHistory(req) {
  return /^[a-f0-9]{24}$/i.test(String(req.query?.userId || ''));
}
async function scopeToOwnDiary(req, query) {
  if (req.admin?.role !== 'doctor' || isGuestHistory(req)) return;
  const mine = await require('../utils/doctorIdentity').resolveDoctorForAdmin(req).catch(() => null);
  const { doctorBookingMatch } = require('../utils/doctorPatients');
  query.$and = [...(query.$and || []), mine ? doctorBookingMatch(mine) : { _id: { $exists: false } }];
}
const { publicEmail, isPlaceholderEmail } = require('../config/zenoti');
const { buildBookingQuery } = require('../utils/listFilters');
const { guestCodeOf } = require('../utils/guestCode');
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
  bookingScheduledAt, clinicDateKey, clinicDayEnd, clinicDayStart, clock24, formatClinicDate,
  parseClockMinutes,
} = require('../utils/bookingTime');
const { UPCOMING: BOOKING_UPCOMING, PAST: BOOKING_PAST } = require('../utils/bookingStatuses');
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
      preferredTimeSlots,
      // Only read for the free package consultation below; every other call
      // ignores them.
      consultContext,
      packageAssignmentId,
      specialistId,
      slotTime,
    } = req.body;

    /*
     * A free consultation raised from an ongoing package (utils/packageConsult).
     *
     * It books one real slot off the treating dermatologist's calendar, like
     * the paid consultation path in paymentController, rather than the
     * "up to three preferred times" a treatment offers — so the time comes in
     * as `slotTime` and stands in for the preferred list from here on. For a
     * normal call `requestedTimes` IS `preferredTimeSlots`, untouched.
     */
    const isPackageConsult = consultContext === 'package_support';
    const consultSlot = isPackageConsult ? clock24(slotTime) : null;
    if (isPackageConsult && !consultSlot) {
      return res.status(400).json({
        success: false,
        code: 'PACKAGE_CONSULT_SLOT_REQUIRED',
        message: 'Choose a time for the consultation.',
      });
    }
    const requestedTimes = isPackageConsult ? [consultSlot] : preferredTimeSlots;

    if (!preferredDate || !Array.isArray(requestedTimes) || !requestedTimes.length
      || requestedTimes.some((time) => parseClockMinutes(time) === null)) {
      return res.status(400).json({
        success: false,
        code: 'INVALID_BOOKING_TIME',
        message: 'Choose a valid date and at least one valid appointment time.',
      });
    }

    // Validate consultation exists
    const consultation = await Consultation.findById(consultationId);
    if (!consultation) {
      return res.status(404).json({
        success: false,
        message: 'Consultation not found'
      });
    }

    // The package benefit is a dermatologist consultation and nothing else —
    // a treatment row under this context would be a free treatment.
    if (isPackageConsult && !isConsultationEntry(consultation)) {
      return res.status(400).json({
        success: false,
        code: 'PACKAGE_CONSULT_NOT_A_CONSULTATION',
        message: 'Only a dermatologist consultation is included with your package.',
      });
    }

    /*
     * A treatment with no Zenoti service behind it cannot be booked.
     *
     * Without a mapping the push to Zenoti never happens: the guest keeps a
     * confirmation and the clinic's diary never hears about it, so they arrive
     * for an appointment nobody knows exists. Three of the first four app
     * bookings failed exactly that way and one guest was left with a slot for
     * the next morning that the clinic had no record of.
     *
     * Refusing the booking is worse for one customer and better for every
     * customer: "not bookable online, please call" is recoverable, turning up
     * to a clinic that has never heard of you is not. Consultations are exempt
     * — resolveServiceId falls back to Zenoti's generic Consultation row, so
     * they always reach the diary.
     */
    if (!isConsultationEntry(consultation)
      && (!consultation.zenotiServiceId || consultation.zenotiCanBook === false)) {
      return res.status(409).json({
        success: false,
        code: 'SERVICE_NOT_BOOKABLE_ONLINE',
        message: `${consultation.name} can't be booked in the app yet — please call the clinic and we'll arrange it for you.`,
      });
    }

    // A new guest's first appointment is a dermatologist consultation; the app
    // hides treatment booking for them, and this enforces it for any client.
    const gate = await require('../utils/guestEligibility').serviceBookingBlock(req.user._id, consultation);
    if (gate) return res.status(gate.status).json({ success: false, code: gate.code, message: gate.message });

    // A treatment set to charge for online booking must go through payment —
    // this direct, pay-at-clinic path is only for those with the toggle off
    // (or no price). Prevents bypassing the payment gate from a client.
    // The package consultation is the one deliberate exception: the package
    // was paid for at purchase and this visit is part of it (checked below).
    if (!isPackageConsult && consultation.chargeOnlineBooking !== false && consultation.price > 0) {
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

    /*
     * The package behind a free consultation, and who it is with.
     *
     * The package must be the guest's own, still ongoing (Active, redeemable
     * at this centre, sessions owed), and the dermatologist asked for must be
     * the one treating them under it — the benefit is a check-in with YOUR
     * dermatologist, not a free slot with any of them. Only when the package
     * names nobody (sessions without a specialist, or theirs has left) is any
     * active dermatologist accepted; the consult-doctor endpoint tells the
     * app which case it is in before the guest picks.
     */
    let packageAssignment = null;
    let packageDoctor = null;
    if (isPackageConsult) {
      const consult = require('../utils/packageConsult');
      packageAssignment = await PackageAssignment.findOne({ _id: packageAssignmentId, userId: req.user._id }).catch(() => null);
      if (!packageAssignment) {
        return res.status(404).json({ success: false, code: 'PACKAGE_NOT_FOUND', message: 'We could not find this package on your account.' });
      }
      const eligibility = consult.packageConsultEligibility(packageAssignment, { branchId: branch._id });
      if (!eligibility.ok) {
        return res.status(409).json({ success: false, code: 'PACKAGE_CONSULT_NOT_ELIGIBLE', reason: eligibility.code, message: eligibility.message });
      }
      packageDoctor = await Doctor.findOne({ doctorId: String(specialistId || '').trim().toLowerCase(), isActive: { $ne: false } });
      if (!packageDoctor) {
        return res.status(404).json({ success: false, code: 'DERMATOLOGIST_NOT_FOUND', message: 'That dermatologist is not available to book.' });
      }
      const treating = await consult.treatingDoctorFor(packageAssignment, { userId: req.user._id });
      if (treating.doctor && String(treating.doctor.doctorId) !== String(packageDoctor.doctorId)) {
        return res.status(409).json({
          success: false,
          code: 'PACKAGE_CONSULT_DOCTOR_MISMATCH',
          message: `Your package is with ${treating.doctor.name} — please request the consultation with them.`,
          data: { doctor: { id: treating.doctor.doctorId, name: treating.doctor.name, tier: treating.doctor.tier, level: treating.doctor.level } },
        });
      }
    }

    if (isPackageConsult) {
      // A real slot off the dermatologist's own calendar, checked the way the
      // paid consultation path checks it (utils/slotGuard: live Zenoti first).
      const { isSlotBookable } = require('../utils/slotGuard');
      const slotCheck = await isSlotBookable(packageDoctor.doctorId, clinicDateKey(preferredDate), consultSlot, { branchId: branch._id });
      if (!slotCheck.ok) {
        return res.status(409).json({
          success: false,
          code: 'DERMATOLOGIST_SLOT_UNAVAILABLE',
          message: `${consultSlot} is no longer available with ${packageDoctor.name}. Please choose another time.`,
          data: { reason: slotCheck.reason || null },
        });
      }
    } else {
      const liveBranch = await require('../services/zenotiAvailabilityService').branchSlots(
        branch._id,
        clinicDateKey(preferredDate),
      );
      const liveMinutes = new Set(liveBranch.slots.map(parseClockMinutes).filter((value) => value !== null));
      const unavailableTime = requestedTimes.find((time) => !liveMinutes.has(parseClockMinutes(time)));
      const scheduleCheck = unavailableTime
        ? { ok: false, code: 'ZENOTI_SLOT_UNAVAILABLE', message: `${unavailableTime} is not available in Zenoti for this clinic.` }
        : { ok: true };
      if (!scheduleCheck.ok) {
        return res.status(409).json({
          success: false,
          code: scheduleCheck.code,
          message: scheduleCheck.message
        });
      }
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
      preferredTimeSlots: requestedTimes,
      amount: consultation.price || 0,
      status: 'Awaiting Confirmation',
      /*
       * The free package consultation: nothing to pay, one held slot with the
       * treating dermatologist, and linked to the package for the desk. Same
       * "Awaiting Confirmation → desk confirms → Zenoti" lifecycle as any
       * consultation. It is NOT a package session (no packageSessionId, not
       * "included"), so the package's balance is left alone — see
       * Booking.consultContext.
       */
      ...(isPackageConsult ? {
        specialistId: packageDoctor.doctorId,
        specialistName: packageDoctor.name,
        specialistTier: packageDoctor.tier,
        slotTime: consultSlot,
        amount: 0,
        paymentStatus: 'pending',
        consultContext: 'package_support',
        packageAssignmentId: packageAssignment._id,
        packageSessionId: null,
        isPackageIncluded: false,
      } : {}),
    });

    console.log('💾 Attempting to save booking with userId:', req.user._id);
    try {
      await booking.save();
    } catch (err) {
      // The slot index (one_live_booking_per_slot) is the real guard: two
      // requests for the same dermatologist slot both pass the check above and
      // only one can insert. Losing that race is "slot unavailable", not a 500.
      if (isPackageConsult && err?.code === 11000 && err?.keyPattern?.specialistId) {
        return res.status(409).json({
          success: false,
          code: 'DERMATOLOGIST_SLOT_UNAVAILABLE',
          message: `${consultSlot} was taken a moment ago. Please choose another time.`,
          data: { reason: 'race' },
        });
      }
      throw err;
    }
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
    
    res.status(error.status || 500).json({
      success: false,
      code: error.code || undefined,
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

    /*
     * Cancel through the lifecycle service — the same call the desk's cancel
     * makes (cancelBookingAdmin below), with via:'guest' instead of 'panel'.
     *
     * This used to set `status` and save directly, which skipped
     * applyPackageSessionSideEffect: a session booked out of a package stayed
     * 'Booked' on the assignment for ever, so a guest who cancelled silently
     * lost that session and the app then showed "awaiting confirmation" with
     * no Book button and no way back. Going through the service also releases
     * the slot in Zenoti and writes the cancel onto the statusLog, so the desk
     * reads the same story the guest does.
     */
    await lifecycle.apply(booking, 'cancel', { via: 'guest', reason: reason.trim() });

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
    if (error.name === 'LifecycleError') {
      return res.status(error.status).json({ success: false, code: error.code, message: error.message, meta: error.meta });
    }
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

    /*
     * Opening a day — Today, the day book, a dermatologist's diary — asks
     * Zenoti for that day straight away, in the background, rather than waiting
     * for the next scheduled pass. What changed reaches the open page over the
     * socket a moment later. Throttled per day window; read-only towards Zenoti.
     */
    const dayKeyPattern = /^\d{4}-\d{2}-\d{2}$/;
    const liveFrom = String(req.query.date || req.query.startDate || '');
    const liveTo = String(req.query.date || req.query.endDate || req.query.startDate || '');
    if (dayKeyPattern.test(liveFrom) && dayKeyPattern.test(liveTo)) {
      require('../services/zenotiAppointmentSyncService').syncWindowOnDemand(liveFrom, liveTo).catch(() => {});
    }

    // Filters + sort are shared with the export endpoint (utils/listFilters).
    const { query, sort, due } = await buildBookingQuery(ownDiaryParams(req));
    await scopeToOwnDiary(req, query);

    // Pagination is opt-in (`limit`) so existing callers keep the full list.
    const perPage = limit ? Math.min(500, Math.max(1, parseInt(limit, 10))) : null;
    const pageNo = Math.max(1, parseInt(page || '1', 10));

    // Plain objects: the populated Branch carries virtuals that assume a full
    // document and throw on this partial projection, which took the whole
    // bookings page down when rows were serialised with virtuals.
    let find = Booking.find(query)
      .populate('consultationId', 'name category price image')
      .populate('userId', 'fullName email phone patientId guestCode')
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
      /*
       * What this visit still owes, resolved against its invoice rather than
       * the booking's own paymentStatus — that field goes stale the moment a
       * bill is raised, so a row can read "pending" long after the guest paid.
       * Only sent when the caller asked for the outstanding list, so the
       * ordinary list costs nothing extra.
       */
      if (due) o.amountDue = due.dueById.get(String(o._id)) ?? 0;
      return o;
    });

    res.status(200).json({
      success: true,
      count: rows.length,
      total,
      statusCounts: Object.fromEntries(statusCounts.map((r) => [r._id, r.n])),
      // The money behind the current filter, so the page can lead with it.
      totals: due ? { dueCount: due.ids.length, due: Math.round(due.total) } : undefined,
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

// @desc    Confirm booking (Admin)
// @route   PUT /api/bookings/admin/:id/confirm
// @access  Private (Admin)
exports.confirmBooking = async (req, res) => {
  let confirmationLockToken = null;
  try {
    const { confirmedDate, confirmedTime } = req.body;

    let booking = await Booking.findById(req.params.id);

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

    const finalDate = clinicDayStart(confirmedDate || booking.preferredDate);
    const finalTime = clock24(confirmedTime);
    if (!finalDate || !finalTime) {
      return res.status(400).json({
        success: false,
        code: 'CONFIRMED_SLOT_REQUIRED',
        message: 'A valid confirmation date and HH:mm time are required.',
      });
    }
    if (!zenotiWrite.isLive()) {
      return res.status(503).json({
        success: false,
        code: 'ZENOTI_WRITE_NOT_LIVE',
        message: 'Confirmation is paused because Zenoti live write-back is not enabled. The booking remains Awaiting Confirmation.',
      });
    }
    if (req.body?.specialistId || req.body?.specialistName) {
      await applyDermatologist(booking, req.body);
    }
    if (!booking.specialistId && !booking.zenotiTherapistId) {
      return res.status(400).json({
        success: false,
        code: 'DERMATOLOGIST_REQUIRED',
        message: 'Choose the dermatologist or therapist before confirming. Zenoti must receive the provider assignment.',
      });
    }

    // Confirming a dermatologist consultation onto a time another guest holds
    // would double-book the diary. Same guard as reschedule: only a genuine
    // clash blocks; leave/hours problems remain a staff judgement call.
    if (booking.specialistId && confirmedTime) {
      const { isSlotBookable } = require('../utils/dermatologistSlots');
      const key = clinicDateKey(confirmedDate || booking.preferredDate);
      const check = key
        ? await isSlotBookable(booking.specialistId, key, finalTime, {
            branchId: booking.branchId || null,
            excludeBookingId: booking._id,
          })
        : { ok: true };
      if (!check.ok) {
        return res.status(409).json({
          success: false,
          code: 'DERMATOLOGIST_SLOT_UNAVAILABLE',
          message: `Zenoti does not allow this doctor at that clinic and time (${check.reason}). Pick a live Zenoti slot.`,
        });
      }
    }

    confirmationLockToken = require('crypto').randomUUID();
    const lock = await Booking.updateOne(
      {
        _id: booking._id,
        status: { $in: ['Awaiting Confirmation', 'Rescheduled'] },
        $or: [
          { 'zenotiConfirmationLock.token': null },
          { 'zenotiConfirmationLock.token': { $exists: false } },
          { 'zenotiConfirmationLock.at': { $lt: new Date(Date.now() - 2 * 60 * 1000) } },
        ],
      },
      { $set: { zenotiConfirmationLock: { token: confirmationLockToken, at: new Date() } } },
    );
    if (!lock.modifiedCount) {
      return res.status(409).json({
        success: false,
        code: 'ZENOTI_CONFIRM_IN_PROGRESS',
        message: 'This booking is already being confirmed in Zenoti. Refresh before trying again.',
      });
    }

    const from = booking.status;
    const previous = {
      confirmedDate: booking.confirmedDate,
      confirmedTime: booking.confirmedTime,
      slotTime: booking.slotTime,
    };
    // Give the write service the exact requested slot while the local booking
    // deliberately remains Awaiting Confirmation. "Confirmed" is committed
    // only after Zenoti returns an appointment id.
    booking.confirmedDate = finalDate;
    booking.confirmedTime = finalTime;
    if (booking.slotTime) booking.slotTime = finalTime;
    booking.$locals.skipZenotiWrite = true;
    await booking.save();

    const outcome = await zenotiWrite.syncBooking(booking._id);
    if (outcome.status !== 'synced') {
      booking.confirmedDate = previous.confirmedDate;
      booking.confirmedTime = previous.confirmedTime;
      booking.slotTime = previous.slotTime;
      booking.$locals.skipZenotiWrite = true;
      await booking.save({ validateModifiedOnly: true });
      await Booking.updateOne({ _id: booking._id, 'zenotiConfirmationLock.token': confirmationLockToken }, { $unset: { zenotiConfirmationLock: 1 } }, { timestamps: false });
      confirmationLockToken = null;
      return res.status(outcome.status === 'reconciliation_required' ? 409 : 502).json({
        success: false,
        code: outcome.status === 'reconciliation_required' ? 'ZENOTI_RECONCILIATION_REQUIRED' : 'ZENOTI_CONFIRM_FAILED',
        message: outcome.error || 'Zenoti did not confirm the appointment. The local booking remains awaiting confirmation.',
      });
    }

    // Reload the identifiers written by syncBooking, then commit the matching
    // local state without firing the legacy asynchronous write hook.
    booking = await Booking.findById(booking._id);
    booking.status = 'Confirmed';
    lifecycle.logStatus(booking, { action: 'confirm', from, to: 'Confirmed', admin: req.admin });
    booking.statusLog[booking.statusLog.length - 1].zenoti = 'synced';
    booking.$locals.skipZenotiWrite = true;
    await booking.save();
    await Booking.updateOne({ _id: booking._id, 'zenotiConfirmationLock.token': confirmationLockToken }, { $unset: { zenotiConfirmationLock: 1 } }, { timestamps: false });
    confirmationLockToken = null;

    /*
     * Stamp the confirmed slot back onto the package session, when this
     * booking came out of a package.
     *
     * Confirming does not go through lifecycle.apply — the generic lifecycle
     * endpoint delegates `confirm` to this handler — so the session row would
     * otherwise keep the date the guest originally asked for and the app would
     * go on saying "Awaiting confirmation · Date with the clinic" long after
     * the desk had settled a time.
     */
    try {
      await lifecycle.applyPackageSessionSideEffect(booking, 'confirm', { now: new Date(), admin: req.admin });
    } catch (sessionError) {
      console.error('Package session stamp after confirm failed:', sessionError.message);
    }

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
    if (confirmationLockToken) {
      await Booking.updateOne(
        { _id: req.params.id, 'zenotiConfirmationLock.token': confirmationLockToken },
        { $unset: { zenotiConfirmationLock: 1 } },
        { timestamps: false },
      ).catch(() => {});
    }
    console.error('❌ Confirm booking error:', error);
    res.status(error.status || 500).json({
      success: false,
      code: error.code || 'BOOKING_CONFIRM_FAILED',
      message: error.message || 'Failed to confirm booking'
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
      .populate('userId', 'fullName email phone patientId guestCode');

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
      await applyDermatologist(booking, req.body);
      booking.$locals.skipZenotiWrite = true;
      await booking.save({ validateModifiedOnly: true });
      req.body.confirmedDate = req.body.confirmedDate || booking.confirmedDate || booking.preferredDate;
      req.body.confirmedTime = req.body.confirmedTime || booking.confirmedTime || booking.slotTime || booking.preferredTimeSlots?.[0];
      return exports.confirmBooking(req, res);
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
    /*
     * A visit Zenoti holds is re-read from Zenoti before its actions are
     * offered — at most once every 10 seconds per booking, waiting up to 2.5 s.
     * A slower answer finishes in the background and reaches the panel over
     * the socket. The desk acts on Zenoti's state as it is now, not as the last
     * mirror pass left it. Read-only towards Zenoti.
     */
    const appointmentSync = require('../services/zenotiAppointmentSyncService');
    const link = await Booking.findById(req.params.id).select('zenotiAppointmentId confirmedDate preferredDate').lean();
    if (!link) return res.status(404).json({ success: false, message: 'Booking not found' });
    if (appointmentSync.bookingNeedsLiveCheck(link)) await appointmentSync.refreshForDesk(link._id);
    // availableActions() hides local-only undos (undo_no_show, undo_cancel) for a
    // visit Zenoti holds, which it can only tell from these two ids — without
    // them the menu offered "Undo no show" and the POST answered 409.
    const booking = await Booking.findById(req.params.id).select('status source confirmedDate confirmedTime preferredDate preferredTimeSlots slotTime statusLog checkInTime checkOutTime zenotiAppointmentId zenotiInvoiceId');
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
    const allSlots = branch
      ? (await require('../services/zenotiAvailabilityService').branchSlots(branch._id, date)).slots
      : [];

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
    const heldMinutes = new Set(bookedSlots.map((slot) => require('../utils/bookingTime').parseClockMinutes(slot)).filter((value) => value !== null));
    const availableSlots = allSlots.filter((slot) => !heldMinutes.has(require('../utils/bookingTime').parseClockMinutes(slot)));

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
    res.status(error.status || 503).json({
      success: false,
      code: error.code || 'ZENOTI_AVAILABILITY_UNAVAILABLE',
      message: error.message || 'Failed to fetch live Zenoti slots'
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
    let { fullName, mobileNumber, email } = req.body;

    // A dermatologist books a follow-up for a guest already on file but is never
    // shown their phone or email (middleware/doctorContactRedaction) — so the
    // contact comes from the record, not the form.
    if (userId && (!fullName || !mobileNumber)) {
      const onFile = await User.findById(userId).select('fullName phone email').lean().catch(() => null);
      if (onFile) {
        fullName = fullName || onFile.fullName;
        mobileNumber = mobileNumber || onFile.phone;
        email = email || onFile.email;
      }
    }

    const lines = Array.isArray(services) && services.length
      ? services
      : [{ consultationId, specialistId, specialistName, specialistTier, amount, time: (Array.isArray(preferredTimeSlots) && preferredTimeSlots[0]) || req.body.confirmedTime, packageAssignmentId, packageSessionId }];

    if (!lines[0]?.consultationId || !fullName || !mobileNumber || !preferredLocation || !preferredDate) {
      return res.status(400).json({
        success: false,
        message: 'consultationId, fullName, mobileNumber, preferredLocation and preferredDate are required',
      });
    }
    if (confirmNow && !zenotiWrite.isLive()) {
      return res.status(503).json({
        success: false,
        code: 'ZENOTI_WRITE_NOT_LIVE',
        message: 'A confirmed reception booking requires Zenoti live write-back. Create it as awaiting, or enable the approved live integration.',
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
      if (!slots.length || slots.some((time) => parseClockMinutes(time) === null)) {
        return res.status(400).json({ success: false, code: 'INVALID_BOOKING_TIME', message: 'At least one valid preferred time slot is required' });
      }
      const lineSpecialistId = line.specialistId || null;
      if (lineSpecialistId && confirmNow && slots[0] && key) {
        // A genuine double-booking always blocks. Any other diary problem
        // (not on shift, leave, outside centre hours, too soon) is reported
        // once so the desk can say Yes/No — Zenoti's "not working at the
        // mentioned time. Do you want to add the appointment?"
        const check = await isSlotBookable(lineSpecialistId, key, slots[0], { branchId: branch._id });
        if (!check.ok) {
          return res.status(409).json({
            success: false,
            code: 'DERMATOLOGIST_SLOT_UNAVAILABLE',
            reason: check.reason,
            message: `Zenoti does not allow ${line.specialistName || specialistName || 'this dermatologist'} at ${slots[0]} (${check.reason}). Choose a live Zenoti slot.`,
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

    // One Zenoti booking reserves one start time for every service item in the
    // visit. Different line times cannot be represented truthfully there.
    if (confirmNow && new Set(prepared.map(({ slots }) => clock24(slots[0]))).size > 1) {
      return res.status(400).json({
        success: false,
        code: 'ZENOTI_VISIT_TIME_MISMATCH',
        message: 'All services in one confirmed visit must start at the same Zenoti time. Create separate visits for different times.',
      });
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
        slotTime: lineSpecialistId && confirmNow ? clock24(slots[0]) : undefined,
        specialistId: lineSpecialistId || undefined,
        specialistName: line.specialistName || (lineSpecialistId ? specialistName : undefined) || undefined,
        specialistTier: line.specialistTier || (lineSpecialistId ? specialistTier : undefined) || undefined,
        amount: lineAmount,
        paymentStatus: assignment ? 'paid' : (paymentStatus || 'pending'),
        paymentMethod: assignment ? 'Package' : undefined,
        isPackageIncluded: Boolean(assignment),
        packageAssignmentId: assignment ? assignment._id : undefined,
        packageSessionId: session ? session._id : undefined,
        status: 'Awaiting Confirmation',
        notes: notes || undefined,
        source: 'reception',
        adminNotes: `Created at reception by ${req.admin?.email || 'admin'}${force ? ' (outside working hours, confirmed by desk)' : ''}`,
      });
      if (confirmNow) {
        booking.confirmedDate = clinicDayStart(preferredDate);
        booking.confirmedTime = clock24(slots[0]);
      }
      booking.$locals.skipZenotiWrite = true;
      await booking.save();
      if (assignment && session) {
        session.bookingId = booking._id;
        session.bookingCreatedAt = new Date();
        session.status = 'Booked';
        session.scheduledDate = clinicDayStart(preferredDate);
        session.scheduledTime = clock24(slots[0]) || slots[0];
        if (lineSpecialistId) { session.specialistId = lineSpecialistId; session.specialistName = line.specialistName || null; }
        await assignment.save();
      }
      created.push({ booking, consultation });
    }

    if (confirmNow) {
      const outcome = await zenotiWrite.syncBooking(created[0].booking._id);
      if (outcome.status !== 'synced') {
        return res.status(outcome.status === 'reconciliation_required' ? 409 : 502).json({
          success: false,
          code: outcome.status === 'reconciliation_required' ? 'ZENOTI_RECONCILIATION_REQUIRED' : 'ZENOTI_CONFIRM_FAILED',
          message: outcome.error || 'Zenoti did not confirm the appointment. It remains Awaiting Confirmation locally.',
          bookings: created.map((row) => row.booking),
        });
      }
      for (const row of created) {
        const synced = await Booking.findById(row.booking._id);
        const from = synced.status;
        synced.status = 'Confirmed';
        lifecycle.logStatus(synced, { action: 'confirm', from, to: 'Confirmed', admin: req.admin });
        synced.statusLog[synced.statusLog.length - 1].zenoti = 'synced';
        synced.$locals.skipZenotiWrite = true;
        await synced.save();
        row.booking = synced;
      }
    }

    const [{ booking, consultation }] = created;
    await booking.populate('consultationId', 'name category price image');
    await booking.populate('userId', 'fullName email phone patientId guestCode');

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
      meta: { createdUser, patientId: guestCodeOf(user), guestCode: user.guestCode || null, visitGroupId },
    });
  } catch (error) {
    console.error('❌ Admin create booking error:', error);
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        message: Object.values(error.errors).map((e) => e.message).join(', '),
      });
    }
    return res.status(error.status || 500).json({
      success: false,
      code: error.code || undefined,
      message: error.message || 'Failed to create booking',
    });
  }
};

// @desc    Reschedule a booking from the panel
// @route   PUT /api/bookings/admin/:id/reschedule
// @access  Private (Admin)
exports.rescheduleBookingAdmin = async (req, res) => {
  let rescheduleLockToken = null;
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
    const rescheduledTime = confirmedTime ? clock24(confirmedTime) : null;
    if (confirmedTime && !rescheduledTime) {
      return res.status(400).json({ success: false, code: 'INVALID_TIME', message: 'confirmedTime must be a valid clinic time.' });
    }
    const prior = {
      status: booking.status,
      preferredDate: booking.preferredDate,
      preferredTimeSlots: [...(booking.preferredTimeSlots || [])],
      confirmedDate: booking.confirmedDate,
      confirmedTime: booking.confirmedTime,
      slotTime: booking.slotTime,
      rescheduledFrom: booking.rescheduledFrom,
      rescheduledAt: booking.rescheduledAt,
      adminNotes: booking.adminNotes,
    };

    // Moving a dermatologist consultation must not land on a slot another
    // guest already holds. Excluding this booking lets it keep (or reclaim)
    // its own time; other diary problems (leave, outside hours) stay a staff
    // judgement call rather than a hard block.
    if (booking.specialistId && rescheduledTime) {
      const { isSlotBookable } = require('../utils/dermatologistSlots');
      const key = clinicDateKey(preferredDate);
      const check = key
        ? await isSlotBookable(booking.specialistId, key, rescheduledTime, {
            branchId: booking.branchId || null,
            excludeBookingId: booking._id,
          })
        : { ok: true };
      if (!check.ok) {
        return res.status(409).json({
          success: false,
          code: 'DERMATOLOGIST_SLOT_UNAVAILABLE',
          message: `Zenoti does not allow that doctor at the requested clinic and time (${check.reason}).`,
        });
      }
    }

    if (booking.zenotiAppointmentId || booking.zenotiInvoiceId) {
      rescheduleLockToken = require('crypto').randomUUID();
      const lock = await Booking.updateOne(
        {
          _id: booking._id,
          $or: [
            { 'zenotiConfirmationLock.token': null },
            { 'zenotiConfirmationLock.token': { $exists: false } },
            { 'zenotiConfirmationLock.at': { $lt: new Date(Date.now() - 2 * 60 * 1000) } },
          ],
        },
        { $set: { zenotiConfirmationLock: { token: rescheduleLockToken, at: new Date() } } },
      );
      if (!lock.modifiedCount) {
        return res.status(409).json({ success: false, code: 'ZENOTI_RESCHEDULE_IN_PROGRESS', message: 'This appointment is already being changed in Zenoti. Refresh before retrying.' });
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
    if (rescheduledTime) {
      booking.confirmedDate = clinicDayStart(preferredDate);
      booking.confirmedTime = rescheduledTime;
      booking.status = 'Confirmed';
    } else {
      booking.status = 'Rescheduled';
      booking.confirmedDate = undefined;
      booking.confirmedTime = undefined;
    }
    // The diary reads slotTime first — a stale value would keep holding the
    // old time while leaving the new one visibly free.
    if (booking.slotTime) booking.slotTime = rescheduledTime || null;
    if (reason) {
      booking.adminNotes = `${booking.adminNotes ? `${booking.adminNotes}\n` : ''}Rescheduled: ${reason}`;
    }

    const targetStatus = booking.status;
    if (booking.zenotiAppointmentId || booking.zenotiInvoiceId) {
      if (!rescheduledTime) {
        Object.assign(booking, prior);
        await Booking.updateOne({ _id: booking._id, 'zenotiConfirmationLock.token': rescheduleLockToken }, { $unset: { zenotiConfirmationLock: 1 } }, { timestamps: false });
        rescheduleLockToken = null;
        return res.status(400).json({ success: false, code: 'CONFIRMED_SLOT_REQUIRED', message: 'A linked Zenoti appointment must be moved to one exact time.' });
      }
      if (!zenotiWrite.isLive()) {
        Object.assign(booking, prior);
        await Booking.updateOne({ _id: booking._id, 'zenotiConfirmationLock.token': rescheduleLockToken }, { $unset: { zenotiConfirmationLock: 1 } }, { timestamps: false });
        rescheduleLockToken = null;
        return res.status(503).json({ success: false, code: 'ZENOTI_WRITE_NOT_LIVE', message: 'Rescheduling is paused because Zenoti live write-back is not enabled.' });
      }
      // Persist the requested coordinates with the old local status so the
      // Zenoti reschedule workflow can read them. Commit Rescheduled/Confirmed
      // only after Zenoti accepts the move.
      booking.status = prior.status;
      booking.$locals.skipZenotiWrite = true;
      await booking.save();
      const outcome = await zenotiWrite.pushLifecycleAction(booking._id, 'reschedule');
      if (outcome.status !== 'synced') {
        Object.assign(booking, prior);
        booking.$locals.skipZenotiWrite = true;
        await booking.save({ validateModifiedOnly: true });
        await Booking.updateOne({ _id: booking._id, 'zenotiConfirmationLock.token': rescheduleLockToken }, { $unset: { zenotiConfirmationLock: 1 } }, { timestamps: false });
        rescheduleLockToken = null;
        return res.status(502).json({ success: false, code: 'ZENOTI_RESCHEDULE_FAILED', message: outcome.error || 'Zenoti did not accept the new time.' });
      }
      booking.status = targetStatus;
      lifecycle.logStatus(booking, { action: 'reschedule', from: prior.status, to: targetStatus, admin: req.admin, reason });
      booking.statusLog[booking.statusLog.length - 1].zenoti = 'synced';
    }
    booking.$locals.skipZenotiWrite = true;
    await booking.save();
    if (rescheduleLockToken) {
      await Booking.updateOne({ _id: booking._id, 'zenotiConfirmationLock.token': rescheduleLockToken }, { $unset: { zenotiConfirmationLock: 1 } }, { timestamps: false });
      rescheduleLockToken = null;
    }

    // A moved appointment must move the package session with it — this handler
    // does not go through lifecycle.apply, so nothing else would re-stamp the
    // session's day and time and the guest would keep reading the old one.
    try {
      await lifecycle.applyPackageSessionSideEffect(booking, 'reschedule', { now: new Date(), admin: req.admin });
    } catch (sessionError) {
      console.error('Package session stamp after reschedule failed:', sessionError.message);
    }

    await booking.populate('consultationId', 'name category price image');
    await booking.populate('userId', 'fullName email phone patientId guestCode');

    return res.status(200).json({
      success: true,
      message: 'Booking rescheduled',
      data: booking,
    });
  } catch (error) {
    if (rescheduleLockToken) {
      await Booking.updateOne(
        { _id: req.params.id, 'zenotiConfirmationLock.token': rescheduleLockToken },
        { $unset: { zenotiConfirmationLock: 1 } },
        { timestamps: false },
      ).catch(() => {});
    }
    console.error('❌ Admin reschedule error:', error);
    return res.status(error.status || 500).json({ success: false, code: error.code || 'BOOKING_RESCHEDULE_FAILED', message: error.message || 'Failed to reschedule booking' });
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
    await booking.populate('userId', 'fullName email phone patientId guestCode');

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
      .populate('consultationId', 'name category price image').populate('userId', 'fullName email phone patientId guestCode').lean();
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
  // Completed has no undo: Zenoti refuses to reopen a closed appointment
  // (AA102), and every completed booking here is a Zenoti appointment. It is
  // corrected in Zenoti and mirrored back within ~10 seconds.
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
    await booking.populate('userId', 'fullName email phone patientId guestCode');
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
