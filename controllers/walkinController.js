/**
 * Walk-in check-in — the tablet at the Zennara front desk.
 *
 * A guest who arrives without an appointment verifies their WhatsApp number,
 * gives the handful of details we need to open a patient record, and fills the
 * pre-consult form. At the end there is a real `User` (mirrored into Zenoti by
 * the model's own post-save hook) and a real `PreConsultForm` marked
 * Submitted, exactly as if they had used the app.
 *
 * Order of events, and why:
 *   send-otp   → verify-otp    the number is proved before anything is written,
 *                              so a mistyped digit never creates a patient.
 *   profile                    the account is created HERE, not at OTP time: a
 *                              User needs a name, a branch and a date of birth,
 *                              and half-built rows for people who wander off
 *                              are worse than none.
 *   preconsult                 the form, against the session issued above.
 *
 * The desk tablet is a shared device. Every response is scoped to the session
 * that call carries, and the front-end drops the session the moment the guest
 * is done.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Token = require('../models/Token');
const Branch = require('../models/Branch');
const PreConsultForm = require('../models/PreConsultForm');
const SignupVerification = require('../models/SignupVerification');
const SecurityLog = require('../models/SecurityLog');
const whatsappService = require('../services/whatsappService');
const logger = require('../utils/logger');
const { placeholderEmail, publicEmail } = require('../config/zenoti');
const { toPreConsultDocument, toFormValues } = require('../utils/walkinPreConsult');

const OTP_RESEND_MS = 30 * 1000;
/** How long the proof from a verified OTP stays usable while details are typed. */
const WALKIN_PROOF_MINUTES = 20;

const digits = (value) => String(value || '').replace(/\D/g, '');

/** The subset of the patient record the desk tablet is allowed to see. */
const publicProfile = (user, { latest = null } = {}) => ({
  id: user._id,
  patientId: user.patientId,
  fullName: user.fullName,
  phone: user.phone,
  email: publicEmail(user.email),
  gender: user.gender || null,
  dateOfBirth: user.dateOfBirth || null,
  location: user.location || null,
  source: user.source || 'app',
  zenotiLinked: Boolean(user.zenotiGuestId),
  ...(latest ? { latest } : {}),
});

/**
 * Mint the ordinary app session. The walk-in tablet then talks to the rest of
 * the API exactly like the phone app does — there is no second kind of guest
 * session to keep secure.
 */
async function issueSession(user, req) {
  const token = jwt.sign(
    { userId: user._id, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRE || '7d' },
  );
  const decoded = jwt.decode(token);
  await Token.create({
    userId: user._id,
    token,
    type: 'access',
    deviceInfo: { platform: req.headers['user-agent'] || 'walk-in kiosk', deviceId: req.headers['device-id'] || null },
    ipAddress: req.ip || req.connection?.remoteAddress || null,
    expiresAt: new Date(decoded.exp * 1000),
    isActive: true,
  });
  return token;
}

/**
 * The guest's most recent submitted form, as form values, for pre-filling.
 *
 * Deliberately NOT `.lean()`. Half this record is encrypted at rest —
 * medical history, allergies, current medication, the recent-activity answers —
 * and mongoose-field-encryption decrypts in a `post('init')` hook, which
 * mongoose skips entirely for lean queries. A lean read hands back ciphertext
 * strings where objects are expected, so the pre-fill would come up silently
 * missing every clinical answer instead of failing loudly.
 */
async function latestFormValues(userId) {
  const doc = await PreConsultForm.findOne({ userId, status: { $ne: 'Draft' } })
    .sort({ createdAt: -1 });
  return doc ? toFormValues(doc.toObject()) : null;
}

// @desc    Branches a walk-in can check in at
// @route   GET /api/walkin/branches
// @access  Public
exports.getBranches = async (req, res) => {
  try {
    const branches = await Branch.find({ isActive: { $ne: false } })
      .select('name address.line1 address.city displayOrder')
      .sort({ displayOrder: 1, name: 1 })
      .lean();
    return res.json({
      success: true,
      data: branches.map((b) => ({
        id: b._id,
        name: b.name,
        city: b.address?.city || null,
        line1: b.address?.line1 || null,
      })),
    });
  } catch (error) {
    logger.error('Walk-in branch list failed', { error: error.message });
    return res.status(500).json({ success: false, message: 'Could not load the centre list.' });
  }
};

// @desc    Send a 4-digit WhatsApp OTP to a walk-in guest
// @route   POST /api/walkin/send-otp
// @access  Public
exports.sendOtp = async (req, res) => {
  try {
    const phone = digits(req.body.phone);
    if (!/^\d{10}$/.test(phone)) {
      return res.status(400).json({ success: false, message: 'Enter a valid 10-digit mobile number.' });
    }

    /*
     * Unlike signup, an already-registered number is fine here — it is how a
     * returning guest checks in. The same OTP record is used either way, so
     * the desk never has to know in advance whether this person is new.
     */
    let verification = await SignupVerification.findOne({ phone });
    if (verification?.updatedAt && Date.now() - verification.updatedAt.getTime() < OTP_RESEND_MS) {
      const wait = Math.ceil((OTP_RESEND_MS - (Date.now() - verification.updatedAt.getTime())) / 1000);
      return res.status(429).json({ success: false, message: `Please wait ${wait}s before requesting another OTP.` });
    }
    if (!verification) verification = new SignupVerification({ phone });

    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    verification.setOTP(otp);
    await verification.save();

    const sent = await whatsappService.sendOTP(phone, otp, 5);
    if (!sent.success) {
      await SignupVerification.deleteOne({ _id: verification._id }).catch(() => {});
      logger.error('Walk-in OTP delivery failed', { phone, error: sent.error });
      return res.status(502).json({ success: false, message: 'Could not send the OTP on WhatsApp. Please try again.' });
    }

    return res.json({ success: true, message: 'OTP sent on WhatsApp.' });
  } catch (error) {
    logger.error('Walk-in send OTP failed', { error: error.message });
    return res.status(500).json({ success: false, message: 'Could not send the OTP. Please try again.' });
  }
};

// @desc    Verify the OTP; sign in an existing guest or authorise a new record
// @route   POST /api/walkin/verify-otp
// @access  Public
exports.verifyOtp = async (req, res) => {
  try {
    const phone = digits(req.body.phone);
    const otp = digits(req.body.otp);
    if (!/^\d{10}$/.test(phone) || otp.length !== 4) {
      return res.status(400).json({ success: false, message: 'Enter the 4-digit code sent on WhatsApp.' });
    }

    const verification = await SignupVerification.findOne({ phone });
    if (!verification) {
      return res.status(400).json({ success: false, message: 'No OTP found. Please request a new one.' });
    }

    const result = verification.verifyOTP(otp);
    await verification.save();
    if (!result.success) {
      return res.status(400).json({ success: false, message: result.message });
    }

    const user = await User.findOne({ phone });

    if (user) {
      if (!user.isActive) {
        return res.status(403).json({
          success: false,
          code: 'ACCOUNT_DEACTIVATED',
          message: 'This account is deactivated. Please ask the front desk for help.',
        });
      }
      /*
       * A returning guest — including one mirrored in from Zenoti who has
       * never opened the app. Sign them in and hand back last visit's answers
       * so the form opens pre-filled instead of asking everything again.
       */
      verification.usedAt = new Date();
      user.phoneVerified = true;
      user.isVerified = true;
      user.lastLogin = new Date();
      await Promise.all([
        verification.save(),
        user.save({ validateModifiedOnly: true }),
      ]);
      const token = await issueSession(user, req);
      await SecurityLog.logEvent(user._id, 'otp_verified', {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        severity: 'low',
      }).catch(() => {});

      return res.json({
        success: true,
        isNew: false,
        token,
        // Profile still incomplete on a Zenoti-mirrored guest (no branch, no
        // date of birth). The desk fills it in on the next screen.
        needsProfile: !user.fullName || !user.location || !user.dateOfBirth || !user.gender,
        user: publicProfile(user, { latest: await latestFormValues(user._id) }),
      });
    }

    // New number: hand back a short-lived proof, nothing is written yet.
    const walkinToken = jwt.sign(
      { purpose: 'walkin', phone, signupVerificationId: verification._id.toString() },
      process.env.JWT_SECRET,
      { expiresIn: `${WALKIN_PROOF_MINUTES}m` },
    );
    return res.json({ success: true, isNew: true, needsProfile: true, walkinToken, phone });
  } catch (error) {
    logger.error('Walk-in verify OTP failed', { error: error.message });
    return res.status(500).json({ success: false, message: 'Could not verify the OTP. Please try again.' });
  }
};

// @desc    Create (or complete) the patient record for a verified walk-in
// @route   POST /api/walkin/profile
// @access  Walk-in proof (new guest) or bearer session (returning guest)
exports.saveProfile = async (req, res) => {
  let consumedVerificationId = null;
  try {
    const fullName = String(req.body.fullName || '').trim();
    const gender = String(req.body.gender || '').trim();
    const location = String(req.body.location || '').trim();
    const dateOfBirth = req.body.dateOfBirth;
    const rawEmail = String(req.body.email || '').trim().toLowerCase();

    if (!fullName || fullName.length < 2) {
      return res.status(400).json({ success: false, message: 'Please enter the guest\'s full name.' });
    }
    if (!['Male', 'Female', 'Other'].includes(gender)) {
      return res.status(400).json({ success: false, message: 'Please select a gender.' });
    }
    if (!location) {
      return res.status(400).json({ success: false, message: 'Please select the centre.' });
    }
    const dob = dateOfBirth ? new Date(dateOfBirth) : null;
    if (!dob || Number.isNaN(dob.getTime()) || dob > new Date()) {
      return res.status(400).json({ success: false, message: 'Please enter a valid date of birth.' });
    }
    if (rawEmail && !/^\S+@\S+\.\S+$/.test(rawEmail)) {
      return res.status(400).json({ success: false, message: 'Enter a valid e-mail address, or leave it blank.' });
    }

    const branch = await Branch.findOne({ name: location, isActive: { $ne: false } }).lean();
    if (!branch) {
      return res.status(400).json({ success: false, message: 'That centre is not available. Please pick another.' });
    }

    /*
     * Returning guest: the bearer session from verify-otp is already on the
     * request, so this is an edit of their own record and needs no proof.
     */
    if (req.user) {
      const user = await User.findById(req.user._id);
      if (rawEmail && rawEmail !== user.email) {
        const clash = await User.findOne({ email: rawEmail, _id: { $ne: user._id } }).select('_id').lean();
        if (clash) {
          return res.status(409).json({ success: false, message: 'That e-mail address is already on another patient.' });
        }
        user.email = rawEmail;
      }
      user.fullName = fullName;
      user.gender = gender;
      user.location = location;
      user.dateOfBirth = dob;
      await user.save({ validateModifiedOnly: true });
      return res.json({ success: true, isNew: false, user: publicProfile(user) });
    }

    // New guest: the walk-in proof from verify-otp is the only authority.
    let proof;
    try {
      proof = jwt.verify(String(req.body.walkinToken || ''), process.env.JWT_SECRET);
      if (proof.purpose !== 'walkin' || !proof.phone || !proof.signupVerificationId) throw new Error('wrong proof');
    } catch {
      return res.status(401).json({
        success: false,
        code: 'PHONE_VERIFICATION_REQUIRED',
        message: 'Please verify the WhatsApp number again.',
      });
    }

    const verification = await SignupVerification.findOne({
      _id: proof.signupVerificationId,
      phone: proof.phone,
      verifiedAt: { $ne: null },
      usedAt: null,
      expiresAt: { $gt: new Date() },
    });
    if (!verification) {
      return res.status(401).json({
        success: false,
        code: 'PHONE_VERIFICATION_REQUIRED',
        message: 'That verification has expired. Please send a new OTP.',
      });
    }

    // Someone may have registered on their phone between the OTP and this call.
    const existing = await User.findOne({ phone: proof.phone });
    if (existing) {
      verification.usedAt = new Date();
      await verification.save();
      const token = await issueSession(existing, req);
      return res.json({ success: true, isNew: false, token, user: publicProfile(existing) });
    }

    if (rawEmail) {
      const clash = await User.findOne({ email: rawEmail }).select('_id').lean();
      if (clash) {
        return res.status(409).json({ success: false, message: 'That e-mail address is already on another patient.' });
      }
    }

    // Consume the proof before writing, so two taps cannot make two patients.
    const consumed = await SignupVerification.findOneAndUpdate(
      { _id: verification._id, usedAt: null },
      { $set: { usedAt: new Date() } },
      { new: true },
    );
    if (!consumed) {
      return res.status(409).json({ success: false, message: 'This check-in was already completed.' });
    }
    consumedVerificationId = consumed._id;

    const ipAddress = req.ip || req.connection?.remoteAddress || req.headers['x-forwarded-for'] || null;
    /*
     * No email is normal at a front desk. We store the same deterministic
     * placeholder the Zenoti import uses, which `publicEmail` renders back as
     * "no email" everywhere — the account stays valid and unique, and nothing
     * is ever posted to an address the guest never gave us.
     */
    const email = rawEmail || placeholderEmail(`walkin_${proof.phone}`);

    const user = await User.create({
      fullName,
      phone: proof.phone,
      email,
      location,
      dateOfBirth: dob,
      gender,
      source: 'reception',
      memberType: 'Regular Member',
      phoneVerified: true,
      isVerified: true,
      /*
       * Consent is captured on paper at the desk before the tablet is handed
       * over, and again explicitly in the form's own declaration. Recording it
       * here keeps the DPDPA trail on the account itself.
       */
      privacyPolicyConsent: { accepted: true, version: '2026-08-09', acceptedAt: new Date(), ipAddress },
      termsOfServiceConsent: { accepted: true, version: '2026-08-09', acceptedAt: new Date(), ipAddress },
      dataRetentionConsent: { accepted: true, retentionPeriodYears: 3, acceptedAt: new Date() },
    });
    // User's post-save hook mirrors the new guest into Zenoti (ensureGuest),
    // gated by ZENOTI_WRITE_MODE. Nothing to do here.

    const token = await issueSession(user, req);
    logger.info('Walk-in patient created', { userId: user._id, patientId: user.patientId, location });

    return res.status(201).json({ success: true, isNew: true, token, user: publicProfile(user) });
  } catch (error) {
    if (consumedVerificationId) {
      await SignupVerification.updateOne({ _id: consumedVerificationId }, { $set: { usedAt: null } }).catch(() => {});
    }
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, message: 'A patient with those details already exists.' });
    }
    logger.error('Walk-in profile save failed', { error: error.message });
    return res.status(500).json({ success: false, message: 'Could not save the details. Please try again.' });
  }
};

// @desc    Who is checked in on this tablet right now
// @route   GET /api/walkin/me
// @access  Bearer session
exports.me = async (req, res) => {
  try {
    return res.json({
      success: true,
      user: publicProfile(req.user, { latest: await latestFormValues(req.user._id) }),
    });
  } catch (error) {
    logger.error('Walk-in me failed', { error: error.message });
    return res.status(500).json({ success: false, message: 'Could not load the guest.' });
  }
};

// @desc    Submit the walk-in pre-consult form
// @route   POST /api/walkin/preconsult
// @access  Bearer session
exports.submitPreConsult = async (req, res) => {
  try {
    const values = req.body || {};
    if (values.consent !== true) {
      return res.status(400).json({
        success: false,
        message: 'The declaration must be confirmed before the form can be submitted.',
        fieldErrors: { consent: 'Please confirm the declaration to continue.' },
      });
    }
    if (!String(values.signature || '').startsWith('data:image/png')) {
      return res.status(400).json({
        success: false,
        message: 'A signature is required.',
        fieldErrors: { signature: 'Please sign in the box to continue.' },
      });
    }
    if (!Array.isArray(values.reasons) || values.reasons.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Select at least one reason for the visit.',
        fieldErrors: { reasons: 'Select at least one reason for your visit.' },
      });
    }

    const user = req.user;
    const doc = toPreConsultDocument(values, {
      user,
      ipAddress: req.ip || req.connection?.remoteAddress || null,
      bookingId: values.bookingId || undefined,
    });

    const form = await PreConsultForm.create({ ...doc, userId: user._id });

    /*
     * Keep the account in step with what the guest just told us. The form is
     * the more recent statement of their own name, e-mail and date of birth,
     * and the panel searches on the account, not the form.
     */
    const patch = {};
    if (values.name && values.name !== user.fullName) patch.fullName = values.name;
    if (values.gender && values.gender !== user.gender) patch.gender = values.gender;
    if (values.email && publicEmail(user.email) !== values.email) {
      const clash = await User.findOne({ email: values.email.toLowerCase(), _id: { $ne: user._id } }).select('_id').lean();
      if (!clash) patch.email = values.email.toLowerCase();
    }
    if (Object.keys(patch).length) {
      /*
       * Saved through the document, not with findByIdAndUpdate: the Zenoti
       * profile write-back hangs off the model's post-save hook, and an
       * update query would skip it, leaving the CRM holding the old name.
       */
      try {
        const fresh = await User.findById(user._id);
        if (fresh) {
          Object.assign(fresh, patch);
          await fresh.save({ validateModifiedOnly: true });
        }
      } catch (err) {
        // The form is already stored; a stale name on the account is a much
        // smaller problem than losing the submission over it.
        logger.warn('Walk-in profile refresh from form failed', { userId: user._id, error: err.message });
      }
    }

    // Record the intake against the Zenoti guest. Best-effort and gated by
    // ZENOTI_WRITE_MODE — a CRM hiccup must never lose the form.
    require('../services/zenotiWriteService').syncFormNote('intake', form).catch(() => {});

    logger.info('Walk-in pre-consult submitted', { userId: user._id, formId: form._id });

    return res.status(201).json({
      success: true,
      data: {
        id: form._id,
        clientId: user.patientId,
        name: form.name,
        dateOfVisit: form.dateOfVisit,
        status: form.status,
      },
    });
  } catch (error) {
    logger.error('Walk-in pre-consult submit failed', { error: error.message });
    return res.status(500).json({ success: false, message: 'Could not submit the form. Please try again.' });
  }
};

// @desc    End the walk-in session on the shared tablet
// @route   POST /api/walkin/finish
// @access  Bearer session
exports.finish = async (req, res) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer') ? header.split(' ')[1] : null;
    if (token) {
      // Sessions are stored by hash now; older ones kept the raw bearer.
      const hash = crypto.createHash('sha256').update(String(token)).digest('hex');
      await Token.updateMany(
        { $or: [{ tokenHash: hash }, { token }], isActive: true },
        { $set: { isActive: false } },
      ).catch(() => {});
    }
    return res.json({ success: true });
  } catch {
    return res.json({ success: true });
  }
};
