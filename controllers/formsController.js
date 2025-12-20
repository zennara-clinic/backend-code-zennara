const PatientConsentForm = require('../models/PatientConsentForm');
const PreConsultForm = require('../models/PreConsultForm');
const ServiceCard = require('../models/ServiceCard');

// @desc    Get all forms (Consent, PreConsult, ServiceCard) - Admin
// @route   GET /api/admin/forms
// @access  Private/Admin
exports.getAllForms = async (req, res) => {
  try {
    const { type, status, page = 1, limit = 20, search } = req.query;

    let forms = [];

    // Fetch different form types based on filter
    if (!type || type === 'consent') {
      const query = {};
      if (status) query.status = status;
      
      const consentForms = await PatientConsentForm.find(query)
        .populate('userId', 'fullName email phone patientId')
        .populate('bookingId', 'referenceNumber preferredDate')
        .lean();

      forms.push(...consentForms.map(form => ({
        ...form,
        formType: 'Consent Form',
        submittedAt: form.createdAt,
        patientName: form.userId?.fullName || form.patientName || 'N/A',
        patientEmail: form.userId?.email || 'N/A',
        patientPhone: form.userId?.phone || 'N/A',
        patientId: form.userId?.patientId || 'N/A'
      })));
    }

    if (!type || type === 'preconsult') {
      const query = {};
      if (status) query.status = status;
      
      const preConsultForms = await PreConsultForm.find(query)
        .populate('userId', 'fullName email phone patientId')
        .populate('bookingId', 'referenceNumber preferredDate')
        .lean();

      forms.push(...preConsultForms.map(form => ({
        ...form,
        formType: 'Pre-Consult Form',
        submittedAt: form.createdAt,
        patientName: form.userId?.fullName || form.name || 'N/A',
        patientEmail: form.userId?.email || form.email || 'N/A',
        patientPhone: form.userId?.phone || form.phoneNumber || 'N/A',
        patientId: form.userId?.patientId || form.clientId || 'N/A'
      })));
    }

    if (!type || type === 'servicecard') {
      const query = {};
      
      const serviceCards = await ServiceCard.find(query)
        .populate('userId', 'fullName email phone patientId')
        .lean();

      forms.push(...serviceCards.map(card => ({
        ...card,
        formType: 'Service Card',
        submittedAt: card.createdAt,
        status: card.isActive ? 'Active' : 'Inactive',
        patientName: card.userId?.fullName || card.clientName || 'N/A',
        patientEmail: card.userId?.email || 'N/A',
        patientPhone: card.userId?.phone || 'N/A',
        patientId: card.userId?.patientId || card.clientId || 'N/A'
      })));
    }

    // Apply search filter
    if (search) {
      const searchLower = search.toLowerCase();
      forms = forms.filter(form => 
        form.patientName?.toLowerCase().includes(searchLower) ||
        form.patientEmail?.toLowerCase().includes(searchLower) ||
        form.patientPhone?.toLowerCase().includes(searchLower) ||
        form.patientId?.toLowerCase().includes(searchLower)
      );
    }

    // Sort by submission date
    forms.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));

    // Pagination
    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    const paginatedForms = forms.slice(startIndex, endIndex);

    res.status(200).json({
      success: true,
      count: paginatedForms.length,
      total: forms.length,
      totalPages: Math.ceil(forms.length / limit),
      currentPage: parseInt(page),
      data: paginatedForms
    });
  } catch (error) {
    console.error('Error fetching all forms:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch forms',
      error: error.message
    });
  }
};

// @desc    Get form by ID and type
// @route   GET /api/admin/forms/:type/:id
// @access  Private/Admin
exports.getFormById = async (req, res) => {
  try {
    const { type, id } = req.params;
    let form;

    switch (type) {
      case 'consent':
        form = await PatientConsentForm.findById(id)
          .populate('userId', 'fullName email phone patientId')
          .populate('bookingId', 'referenceNumber preferredDate status')
          .populate('preConsultFormId', 'dateOfVisit doctorName');
        break;
      case 'preconsult':
        form = await PreConsultForm.findById(id)
          .populate('userId', 'fullName email phone patientId')
          .populate('bookingId', 'referenceNumber preferredDate status');
        break;
      case 'servicecard':
        form = await ServiceCard.findById(id)
          .populate('userId', 'fullName email phone patientId');
        break;
      default:
        return res.status(400).json({
          success: false,
          message: 'Invalid form type'
        });
    }

    if (!form) {
      return res.status(404).json({
        success: false,
        message: 'Form not found'
      });
    }

    res.status(200).json({
      success: true,
      data: form
    });
  } catch (error) {
    console.error('Error fetching form:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch form',
      error: error.message
    });
  }
};

// @desc    Update form status
// @route   PATCH /api/admin/forms/:type/:id/status
// @access  Private/Admin
exports.updateFormStatus = async (req, res) => {
  try {
    const { type, id } = req.params;
    const { status } = req.body;
    let form;

    switch (type) {
      case 'consent':
        if (!['Pending', 'Signed', 'Approved', 'Archived'].includes(status)) {
          return res.status(400).json({
            success: false,
            message: 'Invalid status for consent form'
          });
        }
        form = await PatientConsentForm.findByIdAndUpdate(
          id,
          { status },
          { new: true, runValidators: true }
        );
        break;
      case 'preconsult':
        if (!['Draft', 'Submitted', 'Approved', 'Reviewed', 'Rejected'].includes(status)) {
          return res.status(400).json({
            success: false,
            message: 'Invalid status for pre-consult form'
          });
        }
        form = await PreConsultForm.findByIdAndUpdate(
          id,
          { status },
          { new: true, runValidators: true }
        );
        break;
      case 'servicecard':
        const isActive = status === 'Active';
        form = await ServiceCard.findByIdAndUpdate(
          id,
          { isActive },
          { new: true, runValidators: true }
        );
        break;
      default:
        return res.status(400).json({
          success: false,
          message: 'Invalid form type'
        });
    }

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

// @desc    Delete form
// @route   DELETE /api/admin/forms/:type/:id
// @access  Private/Admin
exports.deleteForm = async (req, res) => {
  try {
    const { type, id } = req.params;
    let form;

    switch (type) {
      case 'consent':
        form = await PatientConsentForm.findByIdAndDelete(id);
        break;
      case 'preconsult':
        form = await PreConsultForm.findByIdAndDelete(id);
        break;
      case 'servicecard':
        form = await ServiceCard.findByIdAndDelete(id);
        break;
      default:
        return res.status(400).json({
          success: false,
          message: 'Invalid form type'
        });
    }

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
    console.error('Error deleting form:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete form',
      error: error.message
    });
  }
};

// @desc    Get form statistics
// @route   GET /api/admin/forms/stats
// @access  Private/Admin
exports.getFormStats = async (req, res) => {
  try {
    const [consentCount, preConsultCount, serviceCardCount] = await Promise.all([
      PatientConsentForm.countDocuments(),
      PreConsultForm.countDocuments(),
      ServiceCard.countDocuments()
    ]);

    const [consentByStatus, preConsultByStatus] = await Promise.all([
      PatientConsentForm.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]),
      PreConsultForm.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ])
    ]);

    res.status(200).json({
      success: true,
      data: {
        total: consentCount + preConsultCount + serviceCardCount,
        consentForms: {
          total: consentCount,
          byStatus: consentByStatus.reduce((acc, item) => {
            acc[item._id] = item.count;
            return acc;
          }, {})
        },
        preConsultForms: {
          total: preConsultCount,
          byStatus: preConsultByStatus.reduce((acc, item) => {
            acc[item._id] = item.count;
            return acc;
          }, {})
        },
        serviceCards: {
          total: serviceCardCount
        }
      }
    });
  } catch (error) {
    console.error('Error fetching form stats:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch form statistics',
      error: error.message
    });
  }
};
