const PreConsultForm = require('../models/PreConsultForm');
const User = require('../models/User');
const Booking = require('../models/Booking');
const { guestCodeOf } = require('../utils/guestCode');

/**
 * A form's provenance as the app and the panels read it: the stored origin,
 * or one worked out from the signature for rows older than the field
 * (PreConsultForm.inferOrigin). Every serialiser in this file goes through
 * here so no screen ever shows a blank "how was this captured".
 */
const originOf = (form) => PreConsultForm.inferOrigin(form);

/** A plain form (doc or lean) with its origin attached. */
const withOrigin = (form) => {
  if (!form) return form;
  const plain = typeof form.toObject === 'function' ? form.toObject() : form;
  return { ...plain, origin: originOf(plain) };
};

/**
 * The origin as the /status endpoint hands it to the app: flat, with the
 * staff member's name only — the app has no use for an Admin id or role.
 */
const publicOrigin = (origin) => (origin ? {
  channel: origin.channel,
  capturedOn: origin.capturedOn,
  paperDate: origin.paperDate || null,
  enteredByName: origin.enteredBy?.name || null,
  enteredAt: origin.enteredAt || null,
  signatureOnPaper: origin.signatureOnPaper === true,
} : null);

// @desc    Create or update pre-consult form
// @route   POST /api/pre-consult-forms
// @access  Private
exports.createOrUpdateForm = async (req, res) => {
  try {
    const userId = req.user._id;
    const formData = req.body;

    // A guest may save a draft or submit; only the clinic moves a form to
    // Reviewed/Approved/Rejected. The consultation gate trusts this field.
    if (formData.status && !['Draft', 'Submitted'].includes(formData.status)) {
      delete formData.status;
    }
    // Provenance is written by the server, never posted: this endpoint is the
    // app, so a form created here is the guest's own digital submission.
    delete formData.origin;
    const APP_ORIGIN = { channel: 'app', capturedOn: 'digital', enteredAt: new Date() };

    // Check if user exists
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // If bookingId is provided, validate it
    if (formData.bookingId) {
      const booking = await Booking.findById(formData.bookingId);
      if (!booking) {
        return res.status(404).json({
          success: false,
          message: 'Booking not found'
        });
      }
    }

    // The app saves the finished intake straight through this endpoint, so a
    // form can arrive here already 'Submitted'. Remember whether it had been
    // submitted BEFORE this write: the Zenoti note is left once, when the
    // intake actually completes, never again on every later save.
    const SUBMITTED_STATES = ['Submitted', 'Approved', 'Reviewed', 'Rejected'];
    let wasSubmitted = false;

    // Check if form already exists for this user and booking
    let form;
    if (formData._id) {
      const before = await PreConsultForm.findOne({ _id: formData._id, userId }).select('status').lean();
      wasSubmitted = SUBMITTED_STATES.includes(before?.status);
      // Update existing form
      form = await PreConsultForm.findOneAndUpdate(
        { _id: formData._id, userId },
        { ...formData, userId },
        { new: true, runValidators: true }
      );
    } else if (formData.bookingId) {
      // Check for existing form with this booking
      form = await PreConsultForm.findOne({ bookingId: formData.bookingId, userId });
      if (form) {
        // Update existing
        wasSubmitted = SUBMITTED_STATES.includes(form.status);
        Object.assign(form, formData);
        await form.save();
      } else {
        // Create new
        form = new PreConsultForm({
          ...formData,
          userId,
          clientId: guestCodeOf(user) || formData.clientId || `CLIENT-${Date.now()}`,
          // The read-back sheet prints the number the guest gave. Spreading
          // formData alone left it null on every app-submitted form, so the
          // sheet showed a dash where the guest had seen their own number —
          // the walk-in translator (utils/walkinPreConsult.js) has always
          // filled it in. Derived from the account the same way clientId is.
          phoneNumber: formData.phoneNumber || user.phone || null,
          origin: APP_ORIGIN
        });
        await form.save();
      }
    } else {
      // Create new form without booking
      form = new PreConsultForm({
        ...formData,
        userId,
        clientId: guestCodeOf(user) || formData.clientId || `CLIENT-${Date.now()}`,
        phoneNumber: formData.phoneNumber || user.phone || null,
        origin: APP_ORIGIN
      });
      await form.save();
    }

    // The clinic works from Zenoti — leave a note there that the intake is
    // done, exactly as submitForm and the walk-in tablet do. Without it an app
    // guest who filled the form in one go (the app never calls /submit) looked
    // to the front desk like they had no intake at all.
    if (form && form.status === 'Submitted' && !wasSubmitted) {
      require('../services/zenotiWriteService').syncFormNote('intake', form).catch(() => {});
    }

    res.status(200).json({
      success: true,
      message: 'Pre-consult form saved successfully',
      data: form
    });
  } catch (error) {
    console.error('Error saving pre-consult form:', error);
    /*
     * A free-text answer over the model's 2000-character cap (previousTreatments,
     * currentMedications, patientNotes) used to come back as a blanket 500 with
     * no field name, so the app could only say "Failed to save" and the guest
     * had no idea which box to shorten.
     *
     * The validator's own message is NOT passed through: Mongoose quotes the
     * offending value inside it ("Path `patientNotes` (`...`) is longer than
     * ..."), which would put clinical free text into an error payload and into
     * every log that records it. Only the field name and the rule are returned.
     */
    if (error.name === 'ValidationError') {
      const describe = (err) => {
        const kind = err?.kind || err?.properties?.type || '';
        if (kind === 'maxlength') {
          const max = err?.properties?.maxlength;
          return `This answer is too long — please keep it under ${max || 'the allowed number of'} characters.`;
        }
        if (kind === 'required') return 'This answer is required.';
        if (kind === 'enum') return 'That is not one of the accepted choices.';
        return 'This answer could not be saved.';
      };
      return res.status(400).json({
        success: false,
        code: 'FORM_VALIDATION_FAILED',
        message: 'Some answers could not be saved. Please check the highlighted fields.',
        errors: Object.entries(error.errors || {}).map(([field, err]) => ({
          field,
          message: describe(err),
        })),
      });
    }
    res.status(500).json({
      success: false,
      message: 'Failed to save pre-consult form',
      error: error.message
    });
  }
};

// @desc    Get user's pre-consult forms
// @route   GET /api/pre-consult-forms
// @access  Private
exports.getUserForms = async (req, res) => {
  try {
    const userId = req.user._id;
    const { status, bookingId } = req.query;

    const query = { userId };
    if (status) query.status = status;
    if (bookingId) query.bookingId = bookingId;

    const forms = await PreConsultForm.find(query)
      .populate('bookingId', 'referenceNumber preferredDate status')
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      count: forms.length,
      data: forms.map(withOrigin)
    });
  } catch (error) {
    console.error('Error fetching pre-consult forms:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch pre-consult forms',
      error: error.message
    });
  }
};


// @desc    Has this guest completed the pre-consultation intake? (cheap gate check)
// @route   GET /api/pre-consult-forms/status
// @access  Private
exports.getMyFormStatus = async (req, res) => {
  try {
    // The app blocks consultation booking until one submitted form exists, so
    // only the newest submitted (or reviewed/approved) one matters here.
    // One shared rule, so this endpoint and the booking gate cannot disagree.
    const { intakeStatus } = require('../utils/preConsultIntake');
    const intake = await intakeStatus(req.user._id);
    /*
     * `state` names what hasSubmitted/waived already meant — digital (their
     * own submission), paper (signed at the desk, held in a folder), none —
     * and `origin` says how a digital one was captured, so the app can show
     * "On paper at Jubilee Hills, 3 Mar 2024" instead of a greyed-out card.
     */
    if (intake.waived) {
      return res.status(200).json({
        success: true,
        data: {
          hasSubmitted: true,
          waived: true,
          waivedReason: intake.reason,
          formId: null,
          status: 'Completed at the clinic',
          draftId: null,
          submittedAt: null,
          state: 'paper',
          origin: null,
          evidence: intake.evidence,
        },
      });
    }
    const done = intake.form;

    // A half-finished form lets the app reopen the draft instead of a blank one.
    const draft = done ? null : await PreConsultForm.findOne({ userId: req.user._id, status: 'Draft' })
      .select('_id').sort({ updatedAt: -1 }).lean();

    res.status(200).json({
      success: true,
      data: {
        hasSubmitted: !!done,
        waived: false,
        waivedReason: null,
        formId: done?._id || null,
        status: done?.status || (draft ? 'Draft' : null),
        draftId: draft?._id || null,
        submittedAt: done?.updatedAt || null,
        state: intake.state,
        origin: publicOrigin(intake.origin),
        evidence: intake.evidence,
      },
    });
  } catch (error) {
    console.error('Error reading pre-consult form status:', error);
    res.status(500).json({ success: false, message: 'Failed to read the form status', error: error.message });
  }
};

// @desc    Get single pre-consult form
// @route   GET /api/pre-consult-forms/:id
// @access  Private
exports.getFormById = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;

    // Fetch form with basic population first
    const form = await PreConsultForm.findOne({ _id: id, userId })
      .populate({
        path: 'bookingId',
        select: 'referenceNumber preferredDate status consultationId',
        populate: {
          path: 'consultationId',
          select: 'name category',
          options: { strictPopulate: false }
        },
        options: { strictPopulate: false }
      });

    if (!form) {
      return res.status(404).json({
        success: false,
        message: 'Form not found'
      });
    }

    // Ensure form data is safe for frontend
    const safeFormData = form.toObject();
    
    // Handle null/undefined nested references gracefully
    if (safeFormData.bookingId && typeof safeFormData.bookingId === 'object') {
      if (!safeFormData.bookingId.consultationId) {
        safeFormData.bookingId.consultationId = null;
      }
    }

    // Ensure all nested objects are safe
    if (!safeFormData.reasonForVisit) {
      safeFormData.reasonForVisit = { skin: false, hair: false, body: false, yoga: false, nutrition: false };
    }
    if (!safeFormData.skinConcerns) {
      safeFormData.skinConcerns = { acnePimple: false, scar: false, pigmentation: false, skinSagging: false, skinTightening: false, wartSkinTag: false };
    }
    if (!safeFormData.hairConcerns) {
      safeFormData.hairConcerns = { hairFallThinning: false, hairRemoval: false, others: null };
    }
    if (!safeFormData.medicalHistory) {
      safeFormData.medicalHistory = { hypertension: false, diabetes: false, thyroid: false, menstrualHistory: null };
    }
    if (!safeFormData.dailyRoutine) {
      safeFormData.dailyRoutine = { cleanser: null, moisturiser: null, sunscreen: null, otherProducts: null };
    }
    if (!safeFormData.diet) {
      safeFormData.diet = { type: null, waterIntakeLiters: null };
    }

    // Ensure clientSignature is safe (prevent split() crash)
    if (!safeFormData.clientSignature) {
      safeFormData.clientSignature = null;
    }
    safeFormData.origin = originOf(safeFormData);

    res.status(200).json({
      success: true,
      data: safeFormData
    });
  } catch (error) {
    console.error('Error fetching pre-consult form:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch pre-consult form',
      error: error.message
    });
  }
};

// @desc    Delete pre-consult form
// @route   DELETE /api/pre-consult-forms/:id
// @access  Private
exports.deleteForm = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;

    const form = await PreConsultForm.findOneAndDelete({ _id: id, userId });

    if (!form) {
      return res.status(404).json({
        success: false,
        message: 'Form not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Form deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting pre-consult form:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete pre-consult form',
      error: error.message
    });
  }
};

// @desc    Submit pre-consult form (change status to Submitted)
// @route   PATCH /api/pre-consult-forms/:id/submit
// @access  Private
exports.submitForm = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;

    const form = await PreConsultForm.findOne({ _id: id, userId });

    if (!form) {
      return res.status(404).json({
        success: false,
        message: 'Form not found'
      });
    }

    if (['Submitted', 'Approved', 'Reviewed', 'Rejected'].includes(form.status)) {
      return res.status(400).json({
        success: false,
        message: 'Form has already been submitted'
      });
    }

    form.status = 'Submitted';
    await form.save();
    // The clinic works from Zenoti — leave a note there that the intake is done.
    require('../services/zenotiWriteService').syncFormNote('intake', form).catch(() => {});

    res.status(200).json({
      success: true,
      message: 'Form submitted successfully',
      data: form
    });
  } catch (error) {
    console.error('Error submitting pre-consult form:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to submit pre-consult form',
      error: error.message
    });
  }
};

// ADMIN ENDPOINTS

// @desc    Get all pre-consult forms (Admin)
// @route   GET /api/admin/pre-consult-forms
// @access  Private/Admin
exports.getAllForms = async (req, res) => {
  try {
    const { status, clientId, userId, bookingId, page = 1, limit = 20 } = req.query;

    const query = {};
    if (status) query.status = status;
    if (clientId) query.clientId = clientId;
    if (userId) query.userId = userId;
    if (bookingId) query.bookingId = bookingId;

    const forms = await PreConsultForm.find(query)
      .populate('userId', 'fullName email phone patientId guestCode')
      .populate('bookingId', 'referenceNumber preferredDate status')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const count = await PreConsultForm.countDocuments(query);

    res.status(200).json({
      success: true,
      count: forms.length,
      totalPages: Math.ceil(count / limit),
      currentPage: page,
      data: forms.map(withOrigin)
    });
  } catch (error) {
    console.error('Error fetching all pre-consult forms:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch pre-consult forms',
      error: error.message
    });
  }
};

// @desc    Get a single pre-consult form with patient context (Admin)
// @route   GET /api/pre-consult-forms/admin/:id
// @access  Private/Admin
exports.getAdminFormById = async (req, res) => {
  try {
    const { id } = req.params;

    const form = await PreConsultForm.findById(id)
      .populate('userId', 'fullName email phone patientId guestCode')
      .populate('bookingId', 'referenceNumber preferredDate status');

    if (!form) {
      return res.status(404).json({
        success: false,
        message: 'Form not found'
      });
    }

    res.status(200).json({
      success: true,
      data: withOrigin(form)
    });
  } catch (error) {
    console.error('Error fetching pre-consult form (admin):', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch pre-consult form',
      error: error.message
    });
  }
};

// @desc    Update form status (Admin)
// @route   PATCH /api/admin/pre-consult-forms/:id/status
// @access  Private/Admin
exports.updateFormStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!['Draft', 'Submitted', 'Approved', 'Reviewed', 'Rejected'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status'
      });
    }

    const form = await PreConsultForm.findByIdAndUpdate(
      id,
      { status },
      { new: true, runValidators: true }
    );

    if (!form) {
      return res.status(404).json({
        success: false,
        message: 'Form not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Form status updated successfully',
      data: form
    });
  } catch (error) {
    console.error('Error updating form status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update form status',
      error: error.message
    });
  }
};

/**
 * GET /api/pre-consult-forms/admin/by-booking/:bookingId
 *
 * "Pre-consultation form: Completed" on an appointment.
 *
 * The appointment screen needs one cheap call that answers three questions —
 * is there a form, is it finished, and what do I open — without pulling the
 * whole encrypted document into a list view. Falls back to the patient's most
 * recent form when none is linked to this booking directly, because a patient
 * who filled the form before the appointment existed still filled it.
 */
exports.getFormStatusForBooking = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.bookingId).select('userId eventAt').lean();
    if (!booking) return res.status(404).json({ success: false, message: 'Appointment not found' });

    /*
     * Scoped to the appointment's OWN guest, never to the bookingId alone.
     * `bookingId` is written from a request body on the create path, so a form
     * carrying somebody else's appointment id is something a client can cause;
     * reading by that id unscoped would then answer this appointment with a
     * stranger's form. The create path at the top of this file has always
     * matched on { bookingId, userId } — this is the same rule on the way out.
     */
    // `origin` and `clientSignature` are read for the provenance only (neither
    // is encrypted); the signature is cut before the response.
    const STATUS_FIELDS = 'status createdAt updatedAt bookingId origin clientSignature';
    let form = await PreConsultForm.findOne({ bookingId: req.params.bookingId, userId: booking.userId })
      .select(STATUS_FIELDS)
      .sort({ updatedAt: -1 })
      .lean();

    let linked = Boolean(form);
    if (!form) {
      form = await PreConsultForm.findOne({ userId: booking.userId })
        .select(STATUS_FIELDS)
        .sort({ updatedAt: -1 })
        .lean();
    }

    const { intakeStatus } = require('../utils/preConsultIntake');
    if (!form) {
      /*
       * A guest the clinic has already seen holds their intake on paper — the
       * same rule the booking gate uses (utils/preConsultIntake). Without this
       * the dermatologist panel flagged long-standing guests "No pre-consult
       * form", as if they were new.
       */
      const intake = booking.userId ? await intakeStatus(booking.userId).catch(() => null) : null;
      if (intake?.waived) {
        return res.json({
          success: true,
          data: { state: 'waived', label: 'On file at the clinic', formId: null, linked: false, reason: intake.reason, intakeState: 'paper' },
        });
      }
      return res.json({
        success: true,
        data: { state: 'not_started', label: 'Not started', formId: null, linked: false, intakeState: 'none' },
      });
    }

    const submitted = ['submitted', 'approved', 'reviewed', 'completed'].includes(String(form.status || '').toLowerCase());
    /*
     * `state` keeps its four appointment-screen values; `intakeState` is the
     * clinic-wide three-state name (utils/preConsultIntake). A draft alone
     * does not say which — the guest may still hold a paper intake — so that
     * case asks the shared rule.
     */
    let intakeState = 'digital';
    if (!submitted) {
      const intake = booking.userId ? await intakeStatus(booking.userId).catch(() => null) : null;
      intakeState = intake?.state || 'none';
    }
    return res.json({
      success: true,
      data: {
        state: submitted ? 'completed' : 'draft',
        label: submitted ? 'Completed' : 'Started, not submitted',
        formId: form._id,
        status: form.status,
        linked,
        updatedAt: form.updatedAt,
        intakeState,
        origin: originOf(form),
      },
    });
  } catch (error) {
    console.error('getFormStatusForBooking failed:', error);
    return res.status(500).json({ success: false, message: 'Could not read the form status' });
  }
};

/**
 * POST /api/pre-consult-forms/photos — the patient attaches photographs.
 *
 * Multipart `photos[]` (max 6). Returns the stored URLs; the app then includes
 * them as `photos: [{ url }]` when it saves the form. Uploading separately
 * keeps the form save a small JSON request and lets a photo be retried on its
 * own if a mobile connection drops mid-way.
 *
 * Patient-authenticated (protect), so this never touches staff permissions;
 * the images go to their own S3 folder and are only ever read back through
 * the form, which is itself access-controlled.
 */
exports.uploadFormPhotos = async (req, res) => {
  try {
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ success: false, message: 'No photo was received' });
    const { uploadToS3 } = require('../services/s3Service');
    const photos = [];
    for (const file of files) {
      const url = await uploadToS3(file, 'preconsult-photos');
      photos.push({ url, uploadedAt: new Date() });
    }
    return res.status(201).json({ success: true, count: photos.length, data: photos });
  } catch (error) {
    console.error('uploadFormPhotos failed:', error);
    return res.status(500).json({ success: false, message: 'Could not save the photographs' });
  }
};

// INTAKE STATE + DIGITISING A PAPER FORM (2026-09-12)

/**
 * GET /api/pre-consult-forms/admin/intake/:userId
 *
 * "Where is this guest's intake?" — one of three answers a staff member can
 * see and act on, from the same rule the booking gate uses:
 *
 *   digital  the guest's own submission (app or desk tablet); open it
 *   paper    signed at the desk, held in a folder; can be typed up here
 *   none     nothing on file; the guest fills it, or the desk does
 *
 * Until now the second state existed only as a boolean the app hid behind a
 * greyed-out card, and 6,071 guests live in it.
 */
exports.getIntakeForUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).select('_id').lean();
    if (!user) return res.status(404).json({ success: false, message: 'Guest not found' });

    const { intakeStatus, labelFor } = require('../utils/preConsultIntake');
    const intake = await intakeStatus(user._id);
    return res.json({
      success: true,
      data: {
        state: intake.state,
        label: labelFor(intake.state),
        formId: intake.form?._id || null,
        form: intake.form ? {
          _id: intake.form._id,
          status: intake.form.status,
          createdAt: intake.form.createdAt,
          dateOfVisit: intake.form.dateOfVisit,
          origin: intake.origin,
        } : null,
        evidence: intake.evidence,
        canDigitise: intake.state !== 'digital',
      },
    });
  } catch (error) {
    console.error('getIntakeForUser failed:', error);
    return res.status(500).json({ success: false, message: 'Could not read the intake state' });
  }
};

/**
 * GET /api/pre-consult-forms/admin/schema
 *
 * The seven steps of the form as data, so the panel editor draws exactly the
 * questions the tablet asks (utils/preConsultSchema).
 */
exports.getSchema = async (_req, res) => {
  try {
    return res.json({ success: true, data: require('../utils/preConsultSchema').describe() });
  } catch (error) {
    console.error('getSchema failed:', error);
    return res.status(500).json({ success: false, message: 'Could not load the form definition' });
  }
};

/**
 * POST /api/pre-consult-forms/admin/digitise/:userId
 *
 * A staff member types up the paper pre-consult sheet a guest signed at the
 * desk. The result is a real Submitted PreConsultForm — the dermatologist
 * panel, the Zenoti note and the booking gate all read it exactly as they
 * read the guest's own submission — with its provenance on it: captured on
 * paper, on the date written on the sheet, entered by whom and when, with the
 * signature on paper rather than on file.
 *
 * Body: { values: <the flat form answers>, paperDate: 'YYYY-MM-DD', notes?, replace? }
 *
 * The guest's consent is the declaration they signed on the sheet, so
 * `healthDataConsent.acceptedAt` is the paper date, not today. No electronic
 * signature is stored: nobody signs on the guest's behalf.
 *
 * Refused with 409 when a submitted form already exists — a typed-up copy
 * must not quietly bury the guest's own words — unless the caller says
 * `replace: true`, in which case the new form becomes the latest and the
 * older one stays in the guest's history.
 */
exports.digitiseForUser = async (req, res) => {
  const logger = require('../utils/logger');
  try {
    const { validate } = require('../utils/preConsultSchema');
    const { toPreConsultDocument } = require('../utils/walkinPreConsult');
    const { clinicDayStart, clinicDateKey } = require('../utils/bookingTime');
    const { publicEmail } = require('../config/zenoti');

    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ success: false, message: 'Guest not found' });

    const body = req.body || {};
    const values = body.values && typeof body.values === 'object' && !Array.isArray(body.values) ? body.values : null;
    if (!values) {
      return res.status(400).json({
        success: false,
        code: 'FORM_VALIDATION_FAILED',
        message: 'The form answers are missing.',
        fieldErrors: { values: 'Send the form answers as `values`.' },
      });
    }

    /*
     * The date on the sheet. A clinic day, never an instant: the guest wrote
     * "3/3/2024" on a form, and that is what dateOfVisit and the consent
     * date should read back as, whatever timezone the panel runs in.
     */
    const paperKey = String(body.paperDate || '').trim();
    const paperDay = /^\d{4}-\d{2}-\d{2}$/.test(paperKey) ? clinicDayStart(paperKey) : null;
    if (!paperDay || Number.isNaN(paperDay.getTime())) {
      return res.status(400).json({
        success: false,
        code: 'PAPER_DATE_INVALID',
        message: 'Enter the date written on the paper form as YYYY-MM-DD.',
        fieldErrors: { paperDate: 'Enter the date on the paper form.' },
      });
    }
    if (paperKey > clinicDateKey(new Date())) {
      return res.status(400).json({
        success: false,
        code: 'PAPER_DATE_INVALID',
        message: 'The paper form cannot be dated in the future.',
        fieldErrors: { paperDate: 'The date on the paper form cannot be in the future.' },
      });
    }

    const checked = validate(values);
    if (!checked.ok) {
      return res.status(400).json({
        success: false,
        code: 'FORM_VALIDATION_FAILED',
        message: 'Some answers could not be saved. Please check the highlighted fields.',
        fieldErrors: checked.errors,
      });
    }

    const { SUBMITTED } = require('../utils/preConsultIntake');
    const existing = await PreConsultForm.findOne({ userId: user._id, status: { $in: SUBMITTED } })
      .select('_id status createdAt origin clientSignature')
      .sort({ updatedAt: -1 })
      .lean();
    if (existing && body.replace !== true) {
      return res.status(409).json({
        success: false,
        code: 'INTAKE_ALREADY_DIGITAL',
        message: 'This guest already has a submitted pre-consult form.',
        formId: existing._id,
        origin: originOf(existing),
      });
    }

    const ipAddress = req.ip || req.connection?.remoteAddress || null;
    // consent: the declaration on the sheet; signature: none — it is on the paper.
    const doc = toPreConsultDocument(
      { ...values, consent: true, signature: '', dateOfVisit: paperKey },
      { user, ipAddress },
    );
    const now = new Date();
    const enteredBy = {
      id: req.admin?._id || null,
      name: req.admin?.name || req.admin?.email || null,
      role: req.admin?.role || null,
    };
    const form = await PreConsultForm.create({
      ...doc,
      userId: user._id,
      status: 'Submitted',
      dateOfVisit: paperDay,
      clientSignature: null,
      healthDataConsent: { ...doc.healthDataConsent, accepted: true, acceptedAt: paperDay, ipAddress },
      origin: {
        channel: 'staff',
        capturedOn: 'paper',
        paperDate: paperDay,
        enteredBy,
        enteredAt: now,
        signatureOnPaper: true,
        notes: typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim().slice(0, 1000) : null,
      },
    });

    /*
     * Keep the account in step with what the sheet says — the same refresh the
     * walk-in tablet does, through the document so the Zenoti profile
     * write-back in User's post-save hook fires.
     */
    const patch = {};
    if (values.name && values.name !== user.fullName) patch.fullName = values.name;
    if (values.gender && values.gender !== user.gender) patch.gender = values.gender;
    if (values.email && publicEmail(user.email) !== values.email) {
      const clash = await User.findOne({ email: String(values.email).toLowerCase(), _id: { $ne: user._id } }).select('_id').lean();
      if (!clash) patch.email = String(values.email).toLowerCase();
    }
    if (Object.keys(patch).length) {
      try {
        Object.assign(user, patch);
        await user.save({ validateModifiedOnly: true });
      } catch (err) {
        // The form is stored; a stale name on the account is the smaller problem.
        logger.warn('Profile refresh from digitised form failed', { userId: user._id, error: err.message });
      }
    }

    // The clinic works from Zenoti — the same intake note the app and tablet leave.
    require('../services/zenotiWriteService').syncFormNote('intake', form).catch(() => {});

    logger.info('Paper pre-consult digitised', {
      userId: user._id,
      formId: form._id,
      paperDate: paperKey,
      adminId: enteredBy.id,
      replaced: existing ? existing._id : null,
    });

    return res.status(201).json({
      success: true,
      data: {
        _id: form._id,
        status: form.status,
        createdAt: form.createdAt,
        dateOfVisit: form.dateOfVisit,
        origin: originOf(form),
      },
    });
  } catch (error) {
    /*
     * A value the model would not take is a form problem, said with a 400 and
     * the field NAMES only — the values are clinical answers and go nowhere
     * near a log line (same rule as the walk-in tablet's submit).
     */
    if (error?.name === 'ValidationError' || error?.name === 'CastError') {
      const fields = error.errors ? Object.keys(error.errors) : [error.path].filter(Boolean);
      const fieldErrors = {};
      for (const field of fields) fieldErrors[field] = 'This answer could not be saved. Please check it and try again.';
      logger.warn('Digitised pre-consult rejected by the model', { userId: req.params.userId, fields });
      return res.status(400).json({
        success: false,
        code: 'FORM_VALIDATION_FAILED',
        message: 'Some answers could not be saved. Please check the highlighted fields.',
        fieldErrors,
      });
    }
    logger.error('Digitise pre-consult failed', { userId: req.params.userId, error: error.message });
    return res.status(500).json({ success: false, message: 'Could not save the digitised form' });
  }
};
