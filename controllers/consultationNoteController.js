const ConsultationNote = require('../models/ConsultationNote');
const Booking = require('../models/Booking');
const { canonical, signedContent, plainOf } = require('../utils/noteSignature');
const { TEMPLATES, buildView, renderPrescriptionHtml, fmtDate } = require('../utils/prescriptionTemplates');
const {
  renderPrescriptionPdf, prescriptionFilename, makeShareToken, shareUrl,
} = require('../utils/prescriptionPdf');

/* ------------------------------------------------------------------------ *
 * Delivery on signature.
 *
 * The clinic's rule (2026-09-12): there is no "send" button anywhere. The
 * dermatologist signs, and the prescription goes to the guest as a PDF — by
 * email as an attachment and by WhatsApp as a document — wherever the guest
 * has an address. A failure is recorded on the note, never raised: a Twilio
 * outage must not undo a clinical signature, and the desk can read on the
 * note exactly what reached the guest and what did not.
 * ------------------------------------------------------------------------ */

/** Addresses minted for walk-ins and WhatsApp-only guests — real to the database, not to a mailbox. */
const PLACEHOLDER_EMAIL = /@(zennara\.local|guest\.zennara\.in)$/i;
const realEmail = (email) => {
  const e = String(email || '').trim();
  return e && e.includes('@') && !PLACEHOLDER_EMAIL.test(e) ? e : null;
};
/** Digits only; whatsappService adds +91 to a bare ten-digit Indian number. */
const realPhone = (phone) => {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits : null;
};

const channel = () => ({ ok: false, to: null, at: null, error: null });
const plainChannel = (c) => (c && typeof c.toObject === 'function' ? c.toObject() : c);

/** The booking fields the printed sheet reads, with the service name populated. */
const bookingForSheet = (bookingId) => (bookingId
  ? Booking.findById(bookingId)
    .select('preferredLocation preferredDate confirmedDate externalServiceName consultationId')
    .populate('consultationId', 'name')
    .lean()
  : null);

/**
 * Has this signature reached the guest yet? True before the first attempt,
 * and again when a channel that HAD an address failed — a later Completed
 * save retries only those. A channel with no address is not retried: the
 * guest's record has to change first, and that is a different save.
 */
function needsDelivery(delivery) {
  if (!delivery || !delivery.at) return true;
  const failed = (c) => c && c.to && !c.ok;
  return failed(delivery.email) || failed(delivery.whatsapp);
}

/** The WhatsApp caption under the document. */
function whatsappCaption(view, guestFirstName) {
  const who = view.doctorName ? `Dr ${String(view.doctorName).replace(/^dr\.?\s*/i, '')}` : 'your dermatologist';
  const where = view.centre ? ` (${view.centre})` : '';
  const when = view.signedAt ? `, signed ${fmtDate(view.signedAt)}` : '';
  return `Hi ${guestFirstName}, here is your prescription from ${who} at Zennara${where}${when}. Keep it for your records — a pharmacy can dispense from it.`;
}

/**
 * Render the PDF once and send it down both channels. Returns the delivery
 * record; `prior` (the note's existing record) keeps a channel that already
 * succeeded so a retry never sends the guest the same file twice.
 */
async function deliverPrescription(note, booking, prior = null) {
  const previous = prior && typeof prior.toObject === 'function' ? prior.toObject() : prior;
  const delivery = {
    at: new Date(),
    pdfBytes: previous?.pdfBytes || 0,
    email: previous?.email?.ok ? plainChannel(previous.email) : channel(),
    whatsapp: previous?.whatsapp?.ok ? plainChannel(previous.whatsapp) : channel(),
  };
  const stamp = (which, patch) => { delivery[which] = { ...delivery[which], at: new Date(), ...patch }; };

  let patient;
  let view;
  let pdf;
  try {
    patient = note.userId && note.userId.fullName !== undefined
      ? note.userId
      : await require('../models/User').findById(note.userId)
        .select('fullName email phone patientId guestCode dateOfBirth gender drugAllergies hasDrugAllergy').lean();
    view = buildView({ note, patient, booking: await bookingForSheet(note.bookingId) || booking, doctorName: note.doctorName });
    pdf = await renderPrescriptionPdf(view, { draft: false });
    delivery.pdfBytes = pdf.length;
  } catch (error) {
    // Nothing can go out without the file; both channels carry the reason.
    console.error('❌ Prescription PDF failed (note saved regardless):', error.message);
    const reason = `PDF could not be rendered: ${error.message}`;
    if (!delivery.email.ok) stamp('email', { error: reason });
    if (!delivery.whatsapp.ok) stamp('whatsapp', { error: reason });
    return delivery;
  }

  const firstName = String(patient?.fullName || 'there').trim().split(/\s+/)[0] || 'there';

  if (!delivery.email.ok) {
    const email = realEmail(patient?.email);
    if (!email) {
      stamp('email', { error: 'No email on file' });
    } else {
      try {
        await require('../utils/emailService').sendPrescriptionEmail(email, patient.fullName, {
          pdf,
          filename: prescriptionFilename(view),
          doctorName: note.doctorName,
          location: view.centre,
          signedAt: view.signedAt,
        });
        stamp('email', { ok: true, to: email, error: null });
      } catch (error) {
        console.error('❌ Prescription email failed (note saved regardless):', error.message);
        stamp('email', { ok: false, to: email, error: error.message });
      }
    }
  }

  if (!delivery.whatsapp.ok) {
    const phone = realPhone(patient?.phone);
    if (!phone) {
      stamp('whatsapp', { error: 'No phone on file' });
    } else {
      try {
        // Twilio fetches the document itself, so it gets a signed link that
        // outlives the send by a week and nothing else.
        const { token } = makeShareToken(note._id);
        const url = shareUrl(token);
        if (!url) throw new Error('API_PUBLIC_URL is not set; WhatsApp cannot fetch the PDF');
        const result = await require('../services/whatsappService').sendDocument(phone, whatsappCaption(view, firstName), url);
        if (result && result.success) stamp('whatsapp', { ok: true, to: phone, error: null });
        else stamp('whatsapp', { ok: false, to: phone, error: (result && result.error) || 'WhatsApp send failed' });
      } catch (error) {
        console.error('❌ Prescription WhatsApp failed (note saved regardless):', error.message);
        stamp('whatsapp', { ok: false, to: phone, error: error.message });
      }
    }
  }

  return delivery;
}

/**
 * What the panel shows after signing: which channel the prescription went
 * out on, which failed, and which had nowhere to go.
 */
function deliveryMessage(delivery) {
  const sent = [];
  const failed = [];
  const missing = [];
  const judge = (c, name, address) => {
    if (c.ok) sent.push(name);
    else if (c.to) failed.push(name);
    else missing.push(address);
  };
  judge(delivery.whatsapp, 'WhatsApp', 'phone');
  judge(delivery.email, 'email', 'email');
  if (sent.length === 2) return 'Signed — sent by WhatsApp and email';
  if (missing.length === 2) return 'Signed — no phone or email on file; nothing sent';
  const parts = [];
  if (sent.length) parts.push(`${sent[0]} sent`);
  if (failed.length) parts.push(`${failed.join(' and ')} failed`);
  if (missing.length) parts.push(`no ${missing[0]} on file`);
  return `Signed — ${parts.join('; ')}`;
}

exports.deliverPrescription = deliverPrescription;
exports.deliveryMessage = deliveryMessage;
exports.needsDelivery = needsDelivery;

// Everything a revision must be able to show: the clinical text, and who had signed it.
const SNAPSHOT_FIELDS = [
  'complaint', 'examination', 'assessment', 'plan', 'sketch',
  'prescription', 'assignedServices', 'followUpDate', 'status',
  'primaryDiagnosis', 'secondaryDiagnosis', 'skinCareAdvice', 'lifestyleAdvice', 'precautions',
  'prescriptionSigned', 'prescriptionSignedAt', 'prescriptionSignedByName',
];

const snapshotOf = (note) => {
  const plain = plainOf(note);
  return SNAPSHOT_FIELDS.reduce((acc, key) => {
    acc[key] = plain[key];
    return acc;
  }, {});
};

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
      .populate('userId', 'fullName email phone patientId guestCode dateOfBirth gender drugAllergies')
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
      .populate('userId', 'fullName email phone patientId guestCode dateOfBirth gender drugAllergies medicalHistory')
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
      primaryDiagnosis, secondaryDiagnosis,
      skinCareAdvice, lifestyleAdvice, precautions,
      prescriptionTemplate,
    } = req.body;

    if (prescriptionTemplate !== undefined && !TEMPLATES.includes(prescriptionTemplate)) {
      return res.status(400).json({
        success: false,
        code: 'UNKNOWN_TEMPLATE',
        message: `Choose one of the prescription designs: ${TEMPLATES.join(', ')}.`,
      });
    }

    /*
     * Signing is a clinical act.
     *
     * Reception may prepare a prescription — that is a real part of the
     * workflow — but marking it Completed is what makes it printable, sendable
     * and legally the dermatologist's. So the permission is checked here, on
     * the server, rather than by hiding a button: a request that sets
     * status:'Completed' without prescriptions.sign is refused outright.
     */
    const canSign = Boolean(
      req.admin?.isSuperAdmin
      || req.admin?.permissions?.has?.('prescriptions.sign')
      || req.admin?.role === 'doctor',
    );
    if (status === 'Completed' && !canSign) {
      return res.status(403).json({
        success: false,
        code: 'SIGNATURE_REQUIRED',
        message: 'A prescription can only be signed by the dermatologist. Save it as a draft for them to review.',
      });
    }

    if (!bookingId) {
      return res.status(400).json({ success: false, message: 'bookingId is required' });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) {
      return res.status(404).json({ success: false, message: 'Booking not found' });
    }

    let note = await ConsultationNote.findOne({ bookingId });

    // The version before this save: kept as a revision if the save changes it.
    let before = null;
    if (note) {
      const snapshot = snapshotOf(note);
      before = { snapshot, content: JSON.stringify(canonical(snapshot) || {}), signed: signedContent(note) };
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
    if (primaryDiagnosis !== undefined) note.primaryDiagnosis = primaryDiagnosis;
    if (secondaryDiagnosis !== undefined) note.secondaryDiagnosis = secondaryDiagnosis;
    if (skinCareAdvice !== undefined) note.skinCareAdvice = skinCareAdvice;
    if (lifestyleAdvice !== undefined) note.lifestyleAdvice = lifestyleAdvice;
    if (precautions !== undefined) note.precautions = precautions;
    // The printed design. Not a signed field, so changing it on a signed note
    // keeps the signature — the text the dermatologist approved is unchanged.
    if (prescriptionTemplate !== undefined) note.prescriptionTemplate = prescriptionTemplate;

    /*
     * An edit to a signed prescription revokes the signature.
     *
     * Otherwise reception could adjust a dose on a document that still carries
     * the dermatologist's name — a signature must only ever attest to the text
     * that was actually approved. The note drops back to Draft and has to be
     * signed again.
     *
     * "Changed" is judged by value (utils/noteSignature), so an autosave that
     * resends the same text leaves the signature alone.
     */
    const signedChanged = before ? signedContent(note) !== before.signed : false;
    if (note.prescriptionSigned && signedChanged && status !== 'Completed') {
      note.prescriptionSigned = false;
      note.prescriptionSignedAt = null;
      note.prescriptionSignedBy = null;
      note.prescriptionSignedByName = null;
      note.status = 'Draft';
      // The guest holds the old version; the next signature must reach them again.
      note.prescriptionEmailedAt = null;
      note.prescriptionEmailedTo = null;
      note.prescriptionDelivery = null;
      note.guestNotifiedAt = null;
    }

    note.savedBy = req.admin?._id || null;
    if (!note.doctorName && req.admin?.name) note.doctorName = req.admin.name;

    if (status === 'Completed') {
      // Re-signing after an edit is legitimate and must refresh the stamp.
      note.status = 'Completed';
      note.completedAt = note.completedAt || new Date();
      note.prescriptionSigned = true;
      note.prescriptionSignedAt = new Date();
      note.prescriptionSignedBy = req.admin?._id || null;
      note.prescriptionSignedByName = req.admin?.name || note.doctorName || null;
    } else if (status && !(note.prescriptionSigned && status === 'Draft')) {
      // A signed note leaves Completed only through a real edit (above). A late
      // autosave still carrying "Draft" must not unpublish a signed prescription.
      note.status = status;
    }

    // One revision per save that changed something, holding the version before it.
    if (before && JSON.stringify(canonical(snapshotOf(note)) || {}) !== before.content) {
      const snapshot = { ...before.snapshot };
      // The sketch is an image: copy it only when this save replaced it.
      if (canonical(snapshot.sketch) === canonical(note.sketch)) delete snapshot.sketch;
      note.revisions.push({ savedAt: new Date(), savedByEmail: req.admin?.email || null, snapshot });
    }

    await note.save();
    await note.populate('userId', 'fullName email phone patientId guestCode dateOfBirth gender drugAllergies hasDrugAllergy');

    // Tell the guest in-app (and on their phone) the moment it is signed — once.
    if (note.status === 'Completed' && !note.guestNotifiedAt) {
      try {
        const who = note.doctorName ? `Dr ${String(note.doctorName).replace(/^dr\.?\s*/i, '')} has` : 'Your dermatologist has';
        await require('../utils/notificationHelper').create({
          userId: note.userId?._id || note.userId,
          type: 'consultation',
          title: 'Your prescription is ready',
          message: `${who} signed your prescription. Open My Prescriptions to view it.`,
          relatedId: note._id,
          relatedModel: null,
          priority: 'high',
          actionUrl: `/prescription/${note._id}`,
          metadata: { kind: 'prescription', prescriptionId: String(note._id), bookingId: String(note.bookingId) },
        });
        note.guestNotifiedAt = new Date();
        note.$locals.skipZenotiWrite = true;
        await note.save({ validateModifiedOnly: true });
      } catch (notifyError) {
        console.error('Prescription notification failed:', notifyError.message);
      }
    }

    /*
     * Signing delivers the prescription in the same breath — the PDF by
     * email and by WhatsApp, wherever the guest has an address. This is the
     * only path a prescription takes to a guest (no send button exists), so
     * the outcome is written on the note and reported back to the panel.
     */
    const hasItems = (note.prescription || []).length > 0;
    let delivery = null;
    if (note.status === 'Completed' && hasItems && needsDelivery(note.prescriptionDelivery)) {
      delivery = await deliverPrescription(note, booking, note.prescriptionDelivery);
      note.prescriptionDelivery = delivery;
      if (delivery.email.ok) {
        note.prescriptionEmailedAt = delivery.email.at;
        note.prescriptionEmailedTo = delivery.email.to;
      }
      try {
        note.$locals.skipZenotiWrite = true;
        await note.save({ validateModifiedOnly: true });
      } catch (recordError) {
        console.error('Prescription delivery record failed:', recordError.message);
      }
    }

    let message = 'Draft saved';
    if (note.status === 'Completed') {
      if (delivery) message = deliveryMessage(delivery);
      else if (!hasItems) message = 'Signed — no medicines on the prescription, nothing to send';
      else message = 'Consultation completed and saved';
    }

    return res.status(200).json({
      success: true,
      message,
      prescriptionEmailed: Boolean(delivery && delivery.email.ok),
      delivery,
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

/*
 * The two render endpoints share one loader and one reading of the query.
 * `template` overrides the design stored on the note so the panel can show
 * the options before the dermatologist saves one; `draft=1` forces the
 * preview ribbon. An unsigned note is always stamped as a preview, whatever
 * the query says — only a signed sheet may pass as a prescription.
 */
async function loadSheet(req, res) {
  const { template, draft } = req.query;
  if (template !== undefined && !TEMPLATES.includes(template)) {
    res.status(400).json({ success: false, code: 'UNKNOWN_TEMPLATE', message: `Choose one of the prescription designs: ${TEMPLATES.join(', ')}.` });
    return null;
  }
  const note = await ConsultationNote.findById(req.params.id)
    .populate('userId', 'fullName patientId guestCode dateOfBirth gender drugAllergies hasDrugAllergy');
  if (!note) {
    res.status(404).json({ success: false, message: 'Consultation note not found' });
    return null;
  }
  const booking = await bookingForSheet(note.bookingId);
  const view = buildView({ note, patient: note.userId, booking, doctorName: note.doctorName });
  const forceDraft = draft === '1' || draft === 'true';
  return { view, template: template || view.template, draft: forceDraft || !view.signed };
}

// @desc    The prescription as a printable page, in a chosen design
// @route   GET /api/consultation-notes/:id/prescription.html?template=&draft=
// @access  Admin (a dermatologist only for their own guests, enforced on the route)
exports.renderPrescription = async (req, res) => {
  try {
    const sheet = await loadSheet(req, res);
    if (!sheet) return undefined;
    const html = renderPrescriptionHtml(sheet.view, { template: sheet.template, draft: sheet.draft });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).type('html').send(html);
  } catch (error) {
    console.error('Render prescription error:', error);
    return res.status(500).json({ success: false, message: 'Failed to render the prescription' });
  }
};

// @desc    The same sheet as the PDF the guest receives
// @route   GET /api/consultation-notes/:id/prescription.pdf?template=&draft=
// @access  Admin (a dermatologist only for their own guests, enforced on the route)
exports.renderPrescriptionPdf = async (req, res) => {
  try {
    const sheet = await loadSheet(req, res);
    if (!sheet) return undefined;
    const pdf = await renderPrescriptionPdf(sheet.view, { template: sheet.template, draft: sheet.draft });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${prescriptionFilename(sheet.view)}"`);
    return res.status(200).send(pdf);
  } catch (error) {
    console.error('Render prescription PDF error:', error);
    return res.status(500).json({ success: false, message: 'Failed to render the prescription' });
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
