/**
 * Self-service email / phone change for the signed-in customer.
 *
 * Security model: to change a contact the customer must first prove they
 * control the CURRENT one (OTP to the current email, or WhatsApp to the current
 * phone). Only then can they submit a new value, which is SCHEDULED and applied
 * automatically a few hours later by utils/contactChangeScheduler.js — no staff
 * action, but the delay gives a visible "we're processing it" state and a
 * cool-off window.
 */
const User = require('../models/User');
const ContactChangeRequest = require('../models/ContactChangeRequest');
const { sendOTPEmail } = require('../utils/emailService');
const whatsappService = require('../services/whatsappService');
const logger = require('../utils/logger');

const DELAY_HOURS = Number(process.env.CONTACT_CHANGE_DELAY_HOURS || 2);
const isPlaceholderEmail = (e) => !e || /@guest\.zennara\.in$/i.test(e);
const normalizePhone = (p) => String(p || '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '');

function maskEmail(email) {
  if (!email) return '';
  const [name, domain] = email.split('@');
  const head = name.slice(0, 1);
  return `${head}${'•'.repeat(Math.max(2, name.length - 1))}@${domain || ''}`;
}
function maskPhone(phone) {
  const p = normalizePhone(phone);
  return p ? `••••••${p.slice(-4)}` : '';
}
/** What the app shows about a pending/active request (no secrets). */
function publicRequest(r) {
  return {
    id: r._id,
    type: r.type,
    status: r.status,
    sentTo: r.sentTo,
    newValueMasked: r.type === 'email' ? maskEmail(r.newValue) : maskPhone(r.newValue),
    scheduledApplyAt: r.scheduledApplyAt,
    appliedAt: r.appliedAt,
    createdAt: r.createdAt,
  };
}

// @desc   Start a change: send an OTP to the CURRENT contact
// @route  POST /api/contact-change/start   body: { type: 'email' | 'phone' }
// @access Private
exports.start = async (req, res) => {
  try {
    const type = req.body.type;
    if (!['email', 'phone'].includes(type)) {
      return res.status(400).json({ success: false, message: 'Choose what to change: email or phone.' });
    }
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    // Retire any earlier open request of this type — one live flow at a time.
    await ContactChangeRequest.updateMany(
      { userId: user._id, type, status: { $in: ['awaiting_verification', 'verified'] } },
      { $set: { status: 'cancelled' } }
    );

    const request = new ContactChangeRequest({
      userId: user._id,
      type,
      currentValue: type === 'email' ? user.email : user.phone,
    });
    const otp = request.setOtp();

    // Deliver the code to the CURRENT contact.
    let delivered = false;
    if (type === 'email') {
      if (isPlaceholderEmail(user.email)) {
        return res.status(400).json({
          success: false,
          message: 'No email is on file to verify. Please contact the clinic to add one first.',
        });
      }
      try {
        await sendOTPEmail(user.email, user.fullName, otp, user.location);
        delivered = true;
        request.sentTo = maskEmail(user.email);
      } catch (e) {
        logger.error('contact-change email OTP failed', { error: e.message });
      }
    } else {
      try {
        const r = await whatsappService.sendOTP(user.phone, otp, 5);
        delivered = Boolean(r?.success);
        request.sentTo = maskPhone(user.phone);
      } catch (e) {
        logger.error('contact-change WhatsApp OTP failed', { error: e.message });
      }
    }

    if (!delivered) {
      return res.status(502).json({ success: false, message: 'Could not send the verification code. Please try again.' });
    }

    await request.save();
    return res.status(200).json({
      success: true,
      message: `Verification code sent to your ${type === 'email' ? 'email' : 'WhatsApp'}.`,
      data: { requestId: request._id, type, sentTo: request.sentTo },
    });
  } catch (error) {
    logger.error('contact-change start failed', { error: error.message });
    res.status(500).json({ success: false, message: 'Could not start the change. Please try again.' });
  }
};

// @desc   Verify the OTP sent to the current contact
// @route  POST /api/contact-change/verify   body: { requestId, otp }
// @access Private
exports.verify = async (req, res) => {
  try {
    const { requestId, otp } = req.body;
    const request = await ContactChangeRequest.findOne({ _id: requestId, userId: req.user._id });
    if (!request || request.status !== 'awaiting_verification') {
      return res.status(404).json({ success: false, message: 'No verification in progress. Please start again.' });
    }
    const result = request.checkOtp(otp);
    if (!result.success) {
      await request.save();
      return res.status(400).json({ success: false, message: result.message });
    }
    request.status = 'verified';
    request.verifiedAt = new Date();
    request.clearOtp();
    await request.save();
    return res.status(200).json({ success: true, message: 'Verified.', data: { requestId: request._id, type: request.type } });
  } catch (error) {
    logger.error('contact-change verify failed', { error: error.message });
    res.status(500).json({ success: false, message: 'Verification failed. Please try again.' });
  }
};

// @desc   Submit the new value → schedules the change for +N hours
// @route  POST /api/contact-change/submit   body: { requestId, newValue }
// @access Private
exports.submit = async (req, res) => {
  try {
    const { requestId, newValue } = req.body;
    const request = await ContactChangeRequest.findOne({ _id: requestId, userId: req.user._id });
    if (!request || request.status !== 'verified') {
      return res.status(400).json({ success: false, message: 'Please verify your current contact first.' });
    }
    const user = await User.findById(req.user._id);

    // Validate + normalise the new value, and make sure it's actually free.
    let value;
    if (request.type === 'email') {
      value = String(newValue || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });
      }
      if (value === String(user.email || '').toLowerCase()) {
        return res.status(400).json({ success: false, message: 'That is already your email.' });
      }
      const taken = await User.findOne({ email: value, _id: { $ne: user._id } }).select('_id');
      if (taken) return res.status(409).json({ success: false, message: 'That email is already in use by another account.' });
    } else {
      value = normalizePhone(newValue);
      if (!/^\d{10}$/.test(value)) {
        return res.status(400).json({ success: false, message: 'Please enter a valid 10-digit mobile number.' });
      }
      if (value === normalizePhone(user.phone)) {
        return res.status(400).json({ success: false, message: 'That is already your mobile number.' });
      }
      const taken = await User.findOne({ phone: value, _id: { $ne: user._id } }).select('_id');
      if (taken) return res.status(409).json({ success: false, message: 'That number is already in use by another account.' });
    }

    request.newValue = value;
    request.status = 'scheduled';
    request.scheduledApplyAt = new Date(Date.now() + DELAY_HOURS * 60 * 60 * 1000);
    await request.save();

    return res.status(200).json({
      success: true,
      message: `We're processing your ${request.type === 'email' ? 'email' : 'mobile number'} change. It will update automatically within a few hours.`,
      data: publicRequest(request),
    });
  } catch (error) {
    logger.error('contact-change submit failed', { error: error.message });
    res.status(500).json({ success: false, message: 'Could not submit the change. Please try again.' });
  }
};

// @desc   The signed-in user's active (scheduled/in-progress) requests
// @route  GET /api/contact-change/pending
// @access Private
exports.getPending = async (req, res) => {
  try {
    const requests = await ContactChangeRequest.find({
      userId: req.user._id,
      status: { $in: ['awaiting_verification', 'verified', 'scheduled'] },
    }).sort({ createdAt: -1 });
    res.status(200).json({ success: true, data: requests.map(publicRequest) });
  } catch (error) {
    logger.error('contact-change getPending failed', { error: error.message });
    res.status(500).json({ success: false, message: 'Could not load your pending changes.' });
  }
};

// @desc   Cancel a request the user no longer wants
// @route  POST /api/contact-change/:id/cancel
// @access Private
exports.cancel = async (req, res) => {
  try {
    const request = await ContactChangeRequest.findOne({ _id: req.params.id, userId: req.user._id });
    if (!request) return res.status(404).json({ success: false, message: 'Request not found' });
    if (['applied', 'cancelled', 'failed'].includes(request.status)) {
      return res.status(400).json({ success: false, message: 'This request can no longer be cancelled.' });
    }
    request.status = 'cancelled';
    await request.save();
    res.status(200).json({ success: true, message: 'Change request cancelled.' });
  } catch (error) {
    logger.error('contact-change cancel failed', { error: error.message });
    res.status(500).json({ success: false, message: 'Could not cancel the request.' });
  }
};

// @desc   Staff view of contact-change requests (panel visibility / audit)
// @route  GET /api/admin/contact-change-requests?status=&type=
// @access Admin
exports.adminList = async (req, res) => {
  try {
    const { status, type } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (type) filter.type = type;
    const requests = await ContactChangeRequest.find(filter)
      .sort({ createdAt: -1 })
      .limit(200)
      .populate('userId', 'fullName email phone patientId')
      .lean();
    const data = requests.map((r) => ({
      id: r._id,
      customer: r.userId ? { id: r.userId._id, fullName: r.userId.fullName, patientId: r.userId.patientId } : null,
      type: r.type,
      status: r.status,
      from: r.currentValue,
      to: r.newValue,
      scheduledApplyAt: r.scheduledApplyAt,
      appliedAt: r.appliedAt,
      failureReason: r.failureReason,
      createdAt: r.createdAt,
    }));
    res.status(200).json({ success: true, count: data.length, data });
  } catch (error) {
    logger.error('contact-change adminList failed', { error: error.message });
    res.status(500).json({ success: false, message: 'Could not load contact-change requests.' });
  }
};
