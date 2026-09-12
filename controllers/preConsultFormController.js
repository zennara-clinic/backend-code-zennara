const PreConsultForm = require('../models/PreConsultForm');
const User = require('../models/User');
const Booking = require('../models/Booking');
const { guestCodeOf } = require('../utils/guestCode');

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
          phoneNumber: formData.phoneNumber || user.phone || null
        });
        await form.save();
      }
    } else {
      // Create new form without booking
      form = new PreConsultForm({
        ...formData,
        userId,
        clientId: guestCodeOf(user) || formData.clientId || `CLIENT-${Date.now()}`,
        phoneNumber: formData.phoneNumber || user.phone || null
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
      data: forms
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
      data: forms
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
      data: form.toObject()
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

    let form = await PreConsultForm.findOne({ bookingId: req.params.bookingId })
      .select('status createdAt updatedAt bookingId')
      .sort({ updatedAt: -1 })
      .lean();

    let linked = Boolean(form);
    if (!form) {
      form = await PreConsultForm.findOne({ userId: booking.userId })
        .select('status createdAt updatedAt bookingId')
        .sort({ updatedAt: -1 })
        .lean();
    }

    if (!form) {
      /*
       * A guest the clinic has already seen holds their intake on paper — the
       * same rule the booking gate uses (utils/preConsultIntake). Without this
       * the dermatologist panel flagged long-standing guests "No pre-consult
       * form", as if they were new.
       */
      const { intakeStatus } = require('../utils/preConsultIntake');
      const intake = booking.userId ? await intakeStatus(booking.userId).catch(() => null) : null;
      if (intake?.waived) {
        return res.json({
          success: true,
          data: { state: 'waived', label: 'On file at the clinic', formId: null, linked: false, reason: intake.reason },
        });
      }
      return res.json({
        success: true,
        data: { state: 'not_started', label: 'Not started', formId: null, linked: false },
      });
    }

    const submitted = ['submitted', 'approved', 'reviewed', 'completed'].includes(String(form.status || '').toLowerCase());
    return res.json({
      success: true,
      data: {
        state: submitted ? 'completed' : 'draft',
        label: submitted ? 'Completed' : 'Started, not submitted',
        formId: form._id,
        status: form.status,
        linked,
        updatedAt: form.updatedAt,
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
