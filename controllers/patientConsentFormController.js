const PatientConsentForm = require('../models/PatientConsentForm');
const User = require('../models/User');
const Booking = require('../models/Booking');
const PreConsultForm = require('../models/PreConsultForm');

// @desc    Create patient consent form
// @route   POST /api/patient-consent-forms
// @access  Private
exports.createConsentForm = async (req, res) => {
  try {
    const userId = req.user._id;
    const formData = req.body;

    // Validate user exists
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Validate booking if provided
    if (formData.bookingId) {
      const booking = await Booking.findById(formData.bookingId);
      if (!booking) {
        return res.status(404).json({
          success: false,
          message: 'Booking not found'
        });
      }
    }

    // Validate pre-consult form if provided
    if (formData.preConsultFormId) {
      const preConsultForm = await PreConsultForm.findById(formData.preConsultFormId);
      if (!preConsultForm) {
        return res.status(404).json({
          success: false,
          message: 'Pre-consult form not found'
        });
      }
    }

    // Every section of the Universal Patient Consent Form must be confirmed,
    // the overall consent given, and a signature captured before we record it.
    const sections = formData.sections || {};
    const allSectionsConfirmed =
      sections.understandingOfTreatment &&
      sections.risksSideEffects &&
      sections.medicalDisclosure &&
      sections.clinicalRecords &&
      sections.financialTerms &&
      sections.liabilityClause &&
      sections.declaration;

    if (!allSectionsConfirmed || !formData.consentGiven) {
      return res.status(400).json({
        success: false,
        message: 'Please confirm all sections and provide your consent to continue'
      });
    }

    if (!formData.patientSignature) {
      return res.status(400).json({
        success: false,
        message: 'Your signature is required to submit the consent form'
      });
    }

    // Create consent form
    const consentForm = new PatientConsentForm({
      ...formData,
      userId,
      status: 'Signed',
      patientSignedAt: new Date()
    });

    await consentForm.save();

    res.status(201).json({
      success: true,
      message: 'Consent form created successfully',
      data: consentForm
    });
  } catch (error) {
    console.error('Error creating consent form:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create consent form',
      error: error.message
    });
  }
};

// @desc    Get user's consent forms
// @route   GET /api/patient-consent-forms
// @access  Private
exports.getUserConsentForms = async (req, res) => {
  try {
    const userId = req.user._id;
    const { status, bookingId } = req.query;

    const query = { userId };
    if (status) query.status = status;
    if (bookingId) query.bookingId = bookingId;

    const forms = await PatientConsentForm.find(query)
      .populate('bookingId', 'referenceNumber preferredDate status')
      .populate('preConsultFormId', 'dateOfVisit doctorName')
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      count: forms.length,
      data: forms
    });
  } catch (error) {
    console.error('Error fetching consent forms:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch consent forms',
      error: error.message
    });
  }
};

// @desc    Get single consent form
// @route   GET /api/patient-consent-forms/:id
// @access  Private
exports.getConsentFormById = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;

    const form = await PatientConsentForm.findOne({ _id: id, userId })
      .populate('bookingId', 'referenceNumber preferredDate status')
      .populate('preConsultFormId', 'dateOfVisit doctorName');

    if (!form) {
      return res.status(404).json({
        success: false,
        message: 'Consent form not found'
      });
    }

    res.status(200).json({
      success: true,
      data: form
    });
  } catch (error) {
    console.error('Error fetching consent form:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch consent form',
      error: error.message
    });
  }
};

// @desc    Update consent form (only if pending)
// @route   PUT /api/patient-consent-forms/:id
// @access  Private
exports.updateConsentForm = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;
    const updateData = req.body;

    const form = await PatientConsentForm.findOne({ _id: id, userId });

    if (!form) {
      return res.status(404).json({
        success: false,
        message: 'Consent form not found'
      });
    }

    if (form.status !== 'Pending') {
      return res.status(400).json({
        success: false,
        message: 'Cannot update a signed or approved consent form'
      });
    }

    // Update form
    Object.assign(form, updateData);
    await form.save();

    res.status(200).json({
      success: true,
      message: 'Consent form updated successfully',
      data: form
    });
  } catch (error) {
    console.error('Error updating consent form:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update consent form',
      error: error.message
    });
  }
};

// @desc    Add doctor signature to consent form
// @route   PATCH /api/patient-consent-forms/:id/doctor-sign
// @access  Private/Admin
exports.addDoctorSignature = async (req, res) => {
  try {
    const { id } = req.params;
    const { doctorSignature } = req.body;

    if (!doctorSignature) {
      return res.status(400).json({
        success: false,
        message: 'Doctor signature is required'
      });
    }

    const form = await PatientConsentForm.findById(id);

    if (!form) {
      return res.status(404).json({
        success: false,
        message: 'Consent form not found'
      });
    }

    form.doctorSignature = doctorSignature;
    form.doctorSignedAt = new Date();
    form.status = 'Approved';
    await form.save();

    res.status(200).json({
      success: true,
      message: 'Doctor signature added successfully',
      data: form
    });
  } catch (error) {
    console.error('Error adding doctor signature:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add doctor signature',
      error: error.message
    });
  }
};

// ADMIN ENDPOINTS

// @desc    Get all consent forms (Admin)
// @route   GET /api/admin/patient-consent-forms
// @access  Private/Admin
exports.getAllConsentForms = async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;

    const query = {};
    if (status) query.status = status;

    const forms = await PatientConsentForm.find(query)
      .populate('userId', 'fullName email phone patientId')
      .populate('bookingId', 'referenceNumber preferredDate status')
      .populate('preConsultFormId', 'dateOfVisit doctorName')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const count = await PatientConsentForm.countDocuments(query);

    res.status(200).json({
      success: true,
      count: forms.length,
      totalPages: Math.ceil(count / limit),
      currentPage: page,
      data: forms
    });
  } catch (error) {
    console.error('Error fetching all consent forms:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch consent forms',
      error: error.message
    });
  }
};

// @desc    Update consent form status (Admin)
// @route   PATCH /api/admin/patient-consent-forms/:id/status
// @access  Private/Admin
exports.updateConsentFormStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, clinicNotes, clinicStamp, doctorName } = req.body;

    if (status && !['Pending', 'Signed', 'Approved', 'Archived'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status'
      });
    }

    const updateData = {};
    if (status) updateData.status = status;
    if (clinicNotes !== undefined) updateData.clinicNotes = clinicNotes;
    if (clinicStamp !== undefined) updateData.clinicStamp = clinicStamp;
    if (doctorName !== undefined) updateData.doctorName = doctorName;

    const form = await PatientConsentForm.findByIdAndUpdate(
      id,
      updateData,
      { new: true, runValidators: true }
    );

    if (!form) {
      return res.status(404).json({
        success: false,
        message: 'Consent form not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Consent form status updated successfully',
      data: form
    });
  } catch (error) {
    console.error('Error updating consent form status:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update consent form status',
      error: error.message
    });
  }
};

// @desc    Get a single consent form with full patient context (Admin)
// @route   GET /api/patient-consent-forms/admin/:id
// @access  Private/Admin
exports.getAdminConsentFormById = async (req, res) => {
  try {
    const { id } = req.params;

    const form = await PatientConsentForm.findById(id)
      .populate('userId', 'fullName email phone patientId dateOfBirth gender')
      .populate('bookingId', 'referenceNumber preferredDate status')
      .populate('preConsultFormId', 'dateOfVisit doctorName');

    if (!form) {
      return res.status(404).json({
        success: false,
        message: 'Consent form not found'
      });
    }

    res.status(200).json({
      success: true,
      data: form
    });
  } catch (error) {
    console.error('Error fetching consent form (admin):', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch consent form',
      error: error.message
    });
  }
};
