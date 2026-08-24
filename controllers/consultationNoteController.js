const ConsultationNote = require('../models/ConsultationNote');
const Booking = require('../models/Booking');

/**
 * Email the signed prescription to the guest. Never throws — a mail outage
 * must not fail the clinical save; the panel can always resend.
 */
async function emailPrescription(note, booking) {
  try {
    const patient = note.userId && note.userId.fullName
      ? note.userId
      : await require('../models/User').findById(note.userId).select('fullName email phone patientId dateOfBirth gender').lean();
    const email = patient?.email;
    if (!email || /@zennara\.local$/i.test(email)) return false; // walk-in placeholder, nowhere to send
    if (!(note.prescription || []).length) return false;

    const { buildPrescriptionDocument } = require('../Email Templates/prescriptionEmailTemplate');
    const docHtml = buildPrescriptionDocument({ note, patient, booking, doctorName: note.doctorName });
    await require('../utils/emailService').sendPrescriptionEmail(email, patient.fullName, {
      docHtml,
      doctorName: note.doctorName,
      location: booking?.preferredLocation || null,
    });
    await ConsultationNote.updateOne(
      { _id: note._id },
      { $set: { prescriptionEmailedAt: new Date(), prescriptionEmailedTo: email } },
    );
    return true;
  } catch (error) {
    console.error('❌ Prescription email failed (note saved regardless):', error.message);
    return false;
  }
}

const SNAPSHOT_FIELDS = [
  'complaint', 'examination', 'assessment', 'plan', 'sketch',
  'prescription', 'assignedServices', 'followUpDate', 'status',
];

const snapshotOf = (note) =>
  SNAPSHOT_FIELDS.reduce((acc, key) => {
    acc[key] = note[key];
    return acc;
  }, {});

// @desc    List consultation notes
// @route   GET /api/consultation-notes
// @access  Admin
exports.getNotes = async (req, res) => {
  try {
    const { doctorId, userId, bookingId, status, limit = 100 } = req.query;

    const filter = {};
    if (doctorId) filter.doctorId = doctorId.toLowerCase();
    if (userId) filter.userId = userId;
    if (bookingId) filter.bookingId = bookingId;
    if (status) filter.status = status;

    const notes = await ConsultationNote.find(filter)
      .populate('userId', 'fullName email phone patientId dateOfBirth gender drugAllergies')
      .populate('bookingId', 'referenceNumber preferredDate confirmedDate confirmedTime status preferredLocation')
      .sort({ createdAt: -1 })
      .limit(Math.min(500, parseInt(limit, 10) || 100))
      .lean();

    return res.status(200).json({ success: true, count: notes.length, data: notes });
  } catch (error) {
    console.error('Get consultation notes error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch consultation notes',
      error: error.message,
    });
  }
};

// @desc    Get the note for one booking (creating nothing if absent)
// @route   GET /api/consultation-notes/booking/:bookingId
// @access  Admin
exports.getNoteForBooking = async (req, res) => {
  try {
    const note = await ConsultationNote.findOne({ bookingId: req.params.bookingId })
      .populate('userId', 'fullName email phone patientId dateOfBirth gender drugAllergies medicalHistory')
      .lean();

    // A booking with no note yet is normal, not an error — the panel opens a
    // blank note in that case.
    return res.status(200).json({ success: true, data: note || null });
  } catch (error) {
    console.error('Get consultation note error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch the consultation note',
      error: error.message,
    });
  }
};

// @desc    Create or update the note for a booking
// @route   POST /api/consultation-notes
// @access  Admin
exports.saveNote = async (req, res) => {
  try {
    const {
      bookingId, complaint, examination, assessment, plan, sketch,
      prescription, assignedServices, followUpDate, status,
    } = req.body;

    if (!bookingId) {
      return res.status(400).json({ success: false, message: 'bookingId is required' });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }

    let note = await ConsultationNote.findOne({ bookingId });

    if (note) {
      // Keep the prior version before overwriting.
      note.revisions.push({
        savedAt: new Date(),
        savedByEmail: req.admin?.email || null,
        snapshot: snapshotOf(note),
      });
    } else {
      // The booking's specialist owns the note; when a booking carries none
      // (walk-in, "any available"), the signed-in doctor does.
      const fallbackDoctorId = req.body.doctorId ? String(req.body.doctorId).toLowerCase() : null;
      note = new ConsultationNote({
        bookingId,
        userId: booking.userId,
        doctorId: (booking.specialistId || fallbackDoctorId || '').toLowerCase() || null,
        doctorName: booking.specialistName || req.body.doctorName || req.admin?.name || null,
      });
    }

    if (complaint !== undefined) note.complaint = complaint;
    if (examination !== undefined) note.examination = examination;
    if (assessment !== undefined) note.assessment = assessment;
    if (plan !== undefined) note.plan = plan;
    if (sketch !== undefined) note.sketch = sketch;
    if (Array.isArray(prescription)) note.prescription = prescription;
    if (Array.isArray(assignedServices)) note.assignedServices = assignedServices;
    if (followUpDate !== undefined) note.followUpDate = followUpDate ? new Date(followUpDate) : null;

    note.savedBy = req.admin?._id || null;
    if (!note.doctorName && req.admin?.name) note.doctorName = req.admin.name;

    if (status === 'Completed' && note.status !== 'Completed') {
      note.status = 'Completed';
      note.completedAt = new Date();
    } else if (status) {
      note.status = status;
    }

    await note.save();
    await note.populate('userId', 'fullName email phone patientId dateOfBirth gender drugAllergies');

    // Signing sends the prescription to the guest's inbox in the same breath —
    // viewable in the body, downloadable as the attachment.
    let emailed = false;
    if (note.status === 'Completed' && (note.prescription || []).length && !note.prescriptionEmailedAt) {
      emailed = await emailPrescription(note, booking);
      if (emailed) {
        note.prescriptionEmailedAt = new Date();
        note.prescriptionEmailedTo = note.userId?.email || null;
      }
    }

    return res.status(200).json({
      success: true,
      message: note.status === 'Completed'
        ? (emailed
            ? `Consultation completed — prescription emailed to ${note.prescriptionEmailedTo}`
            : 'Consultation completed and saved')
        : 'Draft saved',
      prescriptionEmailed: emailed,
      data: note,
    });
  } catch (error) {
    console.error('Save consultation note error:', error);
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        message: Object.values(error.errors).map((e) => e.message).join(', '),
      });
    }
    return res.status(500).json({
      success: false,
      message: 'Failed to save the consultation note',
      error: error.message,
    });
  }
};

// @desc    Email the signed prescription to the guest (first send or resend)
// @route   POST /api/consultation-notes/:id/send
// @access  Admin (any staff — audited by the route)
exports.sendPrescription = async (req, res) => {
  try {
    const note = await ConsultationNote.findById(req.params.id)
      .populate('userId', 'fullName email phone patientId dateOfBirth gender');
    if (!note) return res.status(404).json({ success: false, message: 'Consultation note not found' });
    if (note.status !== 'Completed') {
      return res.status(400).json({ success: false, message: 'Sign the consultation first — only a signed prescription can be sent.' });
    }
    if (!(note.prescription || []).length) {
      return res.status(400).json({ success: false, message: 'There is no prescription on this note.' });
    }
    const email = note.userId?.email;
    if (!email || /@zennara\.local$/i.test(email)) {
      return res.status(400).json({ success: false, message: 'The guest has no email on file — add one to their profile first.' });
    }

    const booking = note.bookingId ? await Booking.findById(note.bookingId).select('preferredLocation').lean() : null;
    const ok = await emailPrescription(note, booking);
    if (!ok) return res.status(502).json({ success: false, message: 'The email could not be sent. Try again in a moment.' });

    return res.status(200).json({ success: true, message: `Prescription emailed to ${email}` });
  } catch (error) {
    console.error('Send prescription error:', error);
    return res.status(500).json({ success: false, message: 'Failed to send the prescription' });
  }
};

// @desc    Delete a note
// @route   DELETE /api/consultation-notes/:id
// @access  Admin (super_admin / admin only, enforced on the route)
exports.deleteNote = async (req, res) => {
  try {
    const note = await ConsultationNote.findById(req.params.id);
    if (!note) {
      return res.status(404).json({ success: false, message: 'Consultation note not found' });
    }

    if (note.status === 'Completed') {
      return res.status(400).json({
        success: false,
        message: 'A completed clinical note cannot be deleted. Correct it by saving a new version instead.',
      });
    }

    await ConsultationNote.deleteOne({ _id: note._id });
    return res.status(200).json({ success: true, message: 'Draft note deleted' });
  } catch (error) {
    console.error('Delete consultation note error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete the consultation note',
      error: error.message,
    });
  }
};
