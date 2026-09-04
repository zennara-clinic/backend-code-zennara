const PreConsultForm = require('../models/PreConsultForm');
const User = require('../models/User');
const Booking = require('../models/Booking');

// @desc    Create or update pre-consult form
// @route   POST /api/pre-consult-forms
// @access  Private
exports.createOrUpdateForm = async (req, res) => {
  try {
    const userId = req.user._id;
    const formData = req.body;

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

    // Check if form already exists for this user and booking
    let form;
    if (formData._id) {
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
        Object.assign(form, formData);
        await form.save();
      } else {
        // Create new
        form = new PreConsultForm({
          ...formData,
          userId,
          clientId: user.patientId || formData.clientId || `CLIENT-${Date.now()}`
        });
        await form.save();
      }
    } else {
      // Create new form without booking
      form = new PreConsultForm({
        ...formData,
        userId,
        clientId: user.patientId || formData.clientId || `CLIENT-${Date.now()}`
      });
      await form.save();
    }

    res.status(200).json({
      success: true,
      message: 'Pre-consult form saved successfully',
      data: form
    });
  } catch (error) {
    console.error('Error saving pre-consult form:', error);
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
      .populate('userId', 'fullName email phone patientId')
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
      .populate('userId', 'fullName email phone patientId')
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
