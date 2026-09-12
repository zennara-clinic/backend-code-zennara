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
const { guestCodeOf } = require('../utils/guestCode');

const OTP_RESEND_MS = 30 * 1000;
/** How long the proof from a verified OTP stays usable while details are typed. */
const WALKIN_PROOF_MINUTES = 20;

/*
 * The code is four digits, and that is the tablet's constraint rather than a
 * choice made here: "Walk-In Form/src/components/PhoneOtp.jsx" renders one
 * input with maxLength={4} and submits the instant a fourth digit is typed, so
 * a six-digit code would be a code nobody could enter. The WhatsApp template
 * takes it as a plain variable and does not care about its length, so the day
 * that input ships six boxes this constant is the only change needed here.
 * Until then guessing is bounded on the record instead: a rolling five failed
 * attempts per number (models/SignupVerification.js), a per-number allowance
 * of codes, and the account lockout honoured in verifyOtp below.
 */
const OTP_DIGITS = 4;

/*
 * The app locks an account for 30 minutes after 10 failed sign-ins
 * (models/User.js, verifyOTP). Same numbers here, on purpose — a lock is only
 * a lock if every door respects it.
 */
const FAILED_LOGINS_BEFORE_LOCK = 10;
const ACCOUNT_LOCK_MS = 30 * 60 * 1000;

const digits = (value) => String(value || '').replace(/\D/g, '');

/**
 * Only the clinics are places a guest checks in.
 *
 * Jubilee Hills, Kondapur and Financial District are centres; the pharmacies
 * and the training centre exist in Zenoti and hold stock, but nothing is
 * booked, sold or seen at them. controllers/branchController.js draws exactly
 * this line, with a comment saying they must never reach a centre picker —
 * the walk-in tablet was offering them anyway. Rows that predate the field
 * still count as clinics.
 */
const clinicOnly = () => [{ centreType: 'clinic' }, { centreType: { $exists: false } }, { centreType: null }];

/**
 * The one guest a phone number means.
 *
 * `phone` is indexed but not unique, and years of Zenoti imports, app signups
 * and desk walk-ins have left a handful of numbers on more than one record.
 * A bare findOne therefore returned whichever row the index reached first,
 * which is not stable between calls: the same person could be signed in as one
 * record at the desk and another in the app, and their history would split in
 * two. Ordering makes the choice deterministic — the Zenoti-linked record is
 * the clinic's own file and always wins, then the most recently used.
 *
 * Returns a full document (never lean): callers save it.
 */
async function findGuestByPhone(phone) {
  const matches = await User.find({ phone }).sort({ lastLogin: -1, createdAt: -1 });
  if (matches.length <= 1) return matches[0] || null;
  return matches.find((u) => u.zenotiGuestId) || matches[0];
}

/** The subset of the patient record the desk tablet is allowed to see. */
const publicProfile = (user, { latest = null } = {}) => ({
  id: user._id,
  patientId: guestCodeOf(user),
  guestCode: user.guestCode || null,
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
 * Mint the tablet's session — scoped to the walk-in, and short.
 *
 * It used to be the ordinary app session: seven days, full run of the guest
 * API. On a device that passes from guest to guest that is the wrong shape
 * entirely — the next person to pick the tablet up inherits the last one's
 * account, and a bearer copied off it keeps working for a week against
 * orders, bookings and prescriptions.
 *
 * So: `scope: 'walkin'` in the claims, which middleware/auth.js refuses
 * anywhere outside the /api/walkin mount and idles out after a few quiet
 * minutes, and an absolute life of WALKIN_SESSION_MINUTES (45 by default) —
 * comfortably longer than a check-in, far shorter than a week. Only the
 * SHA-256 of the bearer is stored, the way admin sessions are, so a database
 * read can never yield a live session; `finish` and auth.js both already look
 * sessions up by either shape.
 */
async function issueSession(user, req) {
  const minutes = Number(process.env.WALKIN_SESSION_MINUTES) || 45;
  const token = jwt.sign(
    { userId: user._id, email: user.email, scope: 'walkin' },
    process.env.JWT_SECRET,
    { expiresIn: `${minutes}m` },
  );
  const decoded = jwt.decode(token);
  await Token.create({
    userId: user._id,
    tokenHash: crypto.createHash('sha256').update(String(token)).digest('hex'),
    type: 'walkin_access',
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
    const branches = await Branch.find({ isActive: { $ne: false }, $or: clinicOnly() })
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

// @desc    Send a WhatsApp OTP to a walk-in guest
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
    const isFirstCode = !verification;
    if (!verification) verification = new SignupVerification({ phone });

    /*
     * Two ceilings the 30-second cooldown cannot give us, both held on the
     * record so they survive a restart and an attacker who changes address:
     *
     *   · this number has been sent its allowance of codes — every one is a
     *     WhatsApp message the clinic pays for, and this endpoint is public,
     *     so "wait 30 seconds" alone is an invitation to run up the bill;
     *   · this number's guessing window is spent — a resend must never hand
     *     back a fresh set of guesses at a live account.
     */
    const allowed = verification.canIssueOTP();
    if (!allowed.allowed) {
      logger.warn('Walk-in OTP refused', { phone, code: allowed.code });
      return res.status(429).json({ success: false, code: allowed.code, message: allowed.message });
    }

    // crypto, not Math.random: this code is the only thing standing between a
    // caller and somebody else's clinical record.
    const otp = crypto.randomInt(10 ** (OTP_DIGITS - 1), 10 ** OTP_DIGITS).toString();
    verification.setOTP(otp);
    verification.registerSend();
    await verification.save();

    const sent = await whatsappService.sendOTP(phone, otp, 5);
    if (!sent.success) {
      /*
       * Only a record we have just created is thrown away. An older one holds
       * this number's guess and send counters, and deleting it would hand
       * anyone who can make delivery fail a way to wipe them; the code it
       * carries is unusable either way, since setOTP has already replaced the
       * hash with one nobody received.
       */
      if (isFirstCode) await SignupVerification.deleteOne({ _id: verification._id }).catch(() => {});
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
    if (!/^\d{10}$/.test(phone) || otp.length !== OTP_DIGITS) {
      return res.status(400).json({ success: false, message: `Enter the ${OTP_DIGITS}-digit code sent on WhatsApp.` });
    }

    const verification = await SignupVerification.findOne({ phone });
    if (!verification) {
      return res.status(400).json({ success: false, message: 'No OTP found. Please request a new one.' });
    }

    /*
     * The guest is looked up BEFORE the code is checked, because the account's
     * own lockout has to be honoured here as well.
     *
     * models/User.js locks a record for 30 minutes after 10 failed sign-ins
     * and the app's OTP login respects that; this endpoint only ever looked at
     * `isActive`, so a number locked out of the app could still be walked
     * straight through at the desk — one door bolted and the other wide open,
     * on a public endpoint. Same fields, same thresholds, so a locked account
     * is now locked everywhere.
     */
    const user = await findGuestByPhone(phone);
    // `new Date(...)`: the app's own lockout writes a millisecond number into
    // this path and lets Mongoose cast it, so both shapes exist in the wild.
    const lockedUntil = user?.accountLockedUntil ? new Date(user.accountLockedUntil).getTime() : 0;
    if (lockedUntil > Date.now()) {
      const minutes = Math.max(1, Math.ceil((lockedUntil - Date.now()) / 60000));
      return res.status(403).json({
        success: false,
        code: 'ACCOUNT_LOCKED',
        message: `This account is locked after too many incorrect codes. Please try again in ${minutes} minute(s).`,
      });
    }

    const result = verification.verifyOTP(otp);
    if (!result.success) {
      // A wrong code at the desk counts against the account exactly as a wrong
      // code in the app does, or no amount of guessing here would ever lock
      // anything.
      if (user) {
        user.failedLoginAttempts = (user.failedLoginAttempts || 0) + 1;
        if (user.failedLoginAttempts >= FAILED_LOGINS_BEFORE_LOCK) {
          user.accountLockedUntil = new Date(Date.now() + ACCOUNT_LOCK_MS);
        }
        await user.save({ validateModifiedOnly: true }).catch(() => {});
      }
      await verification.save();
      return res.status(400).json({ success: false, message: result.message });
    }
    await verification.save();

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
       * never opened the app. Sign them in; the tablet then reads last visit's
       * answers from GET /api/walkin/me, which is behind this session.
       */
      verification.usedAt = new Date();
      user.phoneVerified = true;
      user.isVerified = true;
      user.lastLogin = new Date();
      // The right code clears the account's failed-attempt history, exactly as
      // a successful OTP in the app does.
      user.failedLoginAttempts = 0;
      user.accountLockedUntil = null;
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
        /*
         * The prior clinical record is NOT returned here. This endpoint is
         * public — a phone number and a code reach it — and `latest` carried
         * the lot in plaintext: medical history, allergies, current
         * medication, pregnancy status, last menstrual period. The pre-fill
         * now comes from GET /api/walkin/me, behind the session this response
         * has just issued.
         */
        user: publicProfile(user),
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

    const branch = await Branch.findOne({ name: location, isActive: { $ne: false }, $or: clinicOnly() }).lean();
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
    const existing = await findGuestByPhone(proof.phone);
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
    logger.info('Walk-in patient created', { userId: user._id, patientId: guestCodeOf(user), location });

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

/**
 * What the signature pad actually produces, and nothing else.
 *
 * "starts with data:image/png" accepted any trailing payload of any size and
 * any shape; the path had no ceiling in the model either. 400,000 characters
 * is the cap the tablet states for its own canvas, so anything longer is a
 * client that is not the tablet — refused with a field error rather than left
 * to surface as a 500 from the database.
 */
const SIGNATURE_RE = /^data:image\/png;base64,[A-Za-z0-9+/=\s]+$/;
const SIGNATURE_MAX_CHARS = 400000;

/**
 * A date the guest gave: a Date, `undefined` when nothing was answered, or
 * `null` when something was answered that is not a date.
 *
 * `new Date('tomorrow')` is an Invalid Date, and handing that to Mongoose
 * raises a CastError from inside the save — which is to say the guest's signed
 * form died behind a blanket 500 with nothing naming the field. Answered and
 * unusable has to be told apart from not answered, because the document
 * builder has sensible defaults for the second.
 */
const parsedDay = (value) => {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const day = new Date(value);
  return Number.isNaN(day.getTime()) ? null : day;
};

// @desc    Submit the walk-in pre-consult form
// @route   POST /api/walkin/preconsult
// @access  Bearer session
exports.submitPreConsult = async (req, res) => {
  /*
   * The tablet makes one UUID per filling of the form and resends it on every
   * retry. Declared out here so the duplicate-key branch of the catch can see
   * it. Optional by design: an older client that sends nothing still works,
   * it just loses the protection.
   */
  let submissionId = null;
  try {
    const values = req.body || {};
    submissionId = String(values.submissionId || '').trim().slice(0, 64) || null;
    if (values.consent !== true) {
      return res.status(400).json({
        success: false,
        message: 'The declaration must be confirmed before the form can be submitted.',
        fieldErrors: { consent: 'Please confirm the declaration to continue.' },
      });
    }
    const signature = String(values.signature || '');
    if (!SIGNATURE_RE.test(signature)) {
      return res.status(400).json({
        success: false,
        message: 'A signature is required.',
        fieldErrors: { signature: 'Please sign in the box to continue.' },
      });
    }
    if (signature.length > SIGNATURE_MAX_CHARS) {
      return res.status(400).json({
        success: false,
        message: 'That signature is too large to store.',
        fieldErrors: { signature: 'Please clear the box and sign again.' },
      });
    }
    if (!Array.isArray(values.reasons) || values.reasons.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Select at least one reason for the visit.',
        fieldErrors: { reasons: 'Select at least one reason for your visit.' },
      });
    }

    /*
     * Dates are checked here, before anything is built. utils/walkinPreConsult
     * hands whatever it is given straight to `new Date()`, so a value the tablet
     * could not parse used to reach Mongoose as an Invalid Date and take the
     * whole signed form down with a CastError.
     */
    const dateOfVisit = parsedDay(values.dateOfVisit);
    const dob = parsedDay(values.dob);
    const dateErrors = {};
    if (dateOfVisit === null) dateErrors.dateOfVisit = 'Enter the date of the visit as a real date.';
    if (dob === null) dateErrors.dob = 'Enter the date of birth as a real date.';
    if (Object.keys(dateErrors).length) {
      return res.status(400).json({
        success: false,
        message: 'Please check the dates on the form.',
        fieldErrors: dateErrors,
      });
    }

    const user = req.user;

    /*
     * A dropped response is not a second form. The tablet retries with the
     * same submissionId, and the clinic used to end up with two identical
     * signed records and two identical Zenoti notes against one guest.
     */
    if (submissionId) {
      const already = await PreConsultForm.findOne({ userId: user._id, submissionId });
      if (already) {
        logger.info('Walk-in pre-consult retried with the same key', { userId: user._id, formId: already._id });
        return res.status(200).json({
          success: true,
          duplicate: true,
          data: {
            id: already._id,
            clientId: guestCodeOf(user),
            name: already.name,
            dateOfVisit: already.dateOfVisit,
            status: already.status,
          },
        });
      }
    }

    const doc = toPreConsultDocument(values, {
      user,
      ipAddress: req.ip || req.connection?.remoteAddress || null,
      /*
       * No bookingId. It was read straight off the request body with nothing
       * checking whose appointment it was, so a form could be pinned to
       * another guest's booking and show up on that guest's appointment. The
       * tablet has never sent one — there is no such field in the shared
       * schema — and a walk-in has no appointment anyway; the panels find the
       * form by guest.
       */
    });

    const form = await PreConsultForm.create({
      ...doc,
      userId: user._id,
      ...(submissionId ? { submissionId } : {}),
    });

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
        clientId: guestCodeOf(user),
        name: form.name,
        dateOfVisit: form.dateOfVisit,
        status: form.status,
      },
    });
  } catch (error) {
    /*
     * Two taps that raced each other: the partial unique index on
     * (userId, submissionId) caught the loser, so hand back the form that won
     * rather than telling the guest their submission failed.
     */
    if (submissionId && error?.code === 11000) {
      const already = await PreConsultForm.findOne({ userId: req.user?._id, submissionId }).catch(() => null);
      if (already) {
        return res.status(200).json({
          success: true,
          duplicate: true,
          data: {
            id: already._id,
            clientId: guestCodeOf(req.user),
            name: already.name,
            dateOfVisit: already.dateOfVisit,
            status: already.status,
          },
        });
      }
    }
    /*
     * A value the model would not take is the guest's problem to fix, not a
     * server fault: say which field, and say it with a 400. The field NAMES
     * only ever leave this process — the values are clinical answers and go
     * nowhere near a log line.
     */
    if (error?.name === 'ValidationError' || error?.name === 'CastError') {
      const fields = error.errors ? Object.keys(error.errors) : [error.path].filter(Boolean);
      const fieldErrors = {};
      for (const field of fields) fieldErrors[field] = 'This answer could not be saved. Please check it and try again.';
      logger.warn('Walk-in pre-consult rejected by the model', { userId: req.user?._id, fields });
      return res.status(400).json({
        success: false,
        message: 'Some answers could not be saved. Please check the highlighted fields and try again.',
        fieldErrors,
      });
    }
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
