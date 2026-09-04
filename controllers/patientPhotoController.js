/**
 * Clinical photographs — capture, timeline, and removal.
 *
 * Every handler here touches patient health information, so all of them are
 * behind protectAdmin + a patientPhotos.* permission (see routes/patientPhoto.js).
 * Nothing in this file is reachable by a patient-facing token.
 */
const PatientPhoto = require('../models/PatientPhoto');
const Booking = require('../models/Booking');
const AdminAuditLog = require('../models/AdminAuditLog');
const { uploadToS3, deleteFromS3 } = require('../services/s3Service');

const PHASES = ['before', 'during', 'after'];

/** Non-fatal audit write — a logging failure must not fail a clinical action. */
async function audit(req, action, details, resourceId) {
  try {
    await AdminAuditLog.logAction({
      adminId: req.admin?._id,
      adminEmail: req.admin?.email,
      action,
      resource: 'CLINICAL',
      resourceId,
      details,
      ipAddress: req.adminIp || req.ip,
      userAgent: req.adminUserAgent,
      status: 'SUCCESS',
    });
  } catch (_) { /* audit is best-effort */ }
}

/**
 * POST /api/patient-photos
 * multipart: photos[] plus userId, bookingId, phase, bodyArea, note, takenAt.
 *
 * Accepts several files at once because a dermatologist photographing a face
 * takes three or four angles in one go and should not repeat the form for each.
 */
exports.uploadPhotos = async (req, res) => {
  try {
    const { userId, bookingId, consultationNoteId, phase, bodyArea, note, takenAt } = req.body;
    if (!userId) return res.status(400).json({ success: false, message: 'A patient is required' });

    const files = req.files || [];
    if (!files.length) return res.status(400).json({ success: false, message: 'No photo was received' });

    // Branch comes from the booking when there is one, so the photo is filed
    // against the centre the visit actually happened at.
    let branchId = req.admin?.branchId || null;
    if (bookingId) {
      const booking = await Booking.findById(bookingId).select('branchId userId').lean();
      if (booking) {
        branchId = booking.branchId || branchId;
        if (String(booking.userId) !== String(userId)) {
          return res.status(400).json({ success: false, message: 'That appointment belongs to a different patient' });
        }
      }
    }

    const created = [];
    for (const file of files) {
      // uploadToS3 returns the public URL as a plain string (it re-encodes to
      // JPEG and caps the long edge, so a 12MP phone photo does not become a
      // 6MB row in the patient's timeline).
      const url = await uploadToS3(file, 'patient-photos');
      created.push(await PatientPhoto.create({
        userId,
        bookingId: bookingId || null,
        consultationNoteId: consultationNoteId || null,
        branchId,
        phase: PHASES.includes(phase) ? phase : 'before',
        bodyArea: bodyArea || '',
        note: note || '',
        url,
        // The key is derivable from the URL (deleteFromS3 does exactly that),
        // so it is stored only when the uploader hands one back.
        storageKey: null,
        mimeType: file.mimetype || 'image/jpeg',
        sizeBytes: file.size || 0,
        takenAt: takenAt ? new Date(takenAt) : new Date(),
        takenBy: req.admin?._id || null,
        takenByName: req.admin?.name || '',
        takenByRole: req.admin?.role || '',
      }));
    }

    await audit(req, 'CREATE', { count: created.length, userId, bookingId: bookingId || null, phase }, created[0]?._id);
    return res.status(201).json({ success: true, count: created.length, data: created });
  } catch (error) {
    console.error('uploadPhotos failed:', error);
    return res.status(500).json({ success: false, message: 'Could not save the photographs' });
  }
};

/**
 * GET /api/patient-photos?userId=&bookingId=&phase=
 * Newest first, always — the clinical timeline reads most-recent-to-oldest
 * like every other history list in the system.
 */
exports.listPhotos = async (req, res) => {
  try {
    const { userId, bookingId, phase, limit = 200 } = req.query;
    if (!userId && !bookingId) {
      return res.status(400).json({ success: false, message: 'A patient or an appointment is required' });
    }

    const query = { isDeleted: false };
    if (userId) query.userId = userId;
    if (bookingId) query.bookingId = bookingId;
    if (PHASES.includes(phase)) query.phase = phase;

    const photos = await PatientPhoto.find(query)
      .sort({ takenAt: -1, _id: -1 })
      .limit(Math.min(Number(limit) || 200, 500))
      .populate('bookingId', 'referenceNumber eventAt confirmedDate preferredDate externalServiceName')
      .lean();

    return res.json({ success: true, count: photos.length, data: photos });
  } catch (error) {
    console.error('listPhotos failed:', error);
    return res.status(500).json({ success: false, message: 'Could not load the photographs' });
  }
};

/** PATCH /api/patient-photos/:id — re-file a photo (phase, area, note, visit). */
exports.updatePhoto = async (req, res) => {
  try {
    const allowed = ['phase', 'bodyArea', 'note', 'bookingId', 'consultationNoteId', 'takenAt'];
    const set = {};
    for (const key of allowed) {
      if (req.body[key] === undefined) continue;
      if (key === 'phase' && !PHASES.includes(req.body.phase)) continue;
      set[key] = req.body[key];
    }
    const photo = await PatientPhoto.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false },
      { $set: set },
      { new: true },
    );
    if (!photo) return res.status(404).json({ success: false, message: 'Photograph not found' });
    await audit(req, 'UPDATE', { fields: Object.keys(set) }, photo._id);
    return res.json({ success: true, data: photo });
  } catch (error) {
    console.error('updatePhoto failed:', error);
    return res.status(500).json({ success: false, message: 'Could not update the photograph' });
  }
};

/**
 * DELETE /api/patient-photos/:id — soft delete by default.
 *
 * `?hard=true` also removes the S3 object and is restricted to accounts with
 * patientPhotos.manage; it exists for a genuine mis-capture (wrong patient),
 * not for tidying a record.
 */
exports.deletePhoto = async (req, res) => {
  try {
    const photo = await PatientPhoto.findById(req.params.id);
    if (!photo) return res.status(404).json({ success: false, message: 'Photograph not found' });

    const hard = String(req.query.hard || '') === 'true';
    if (hard) {
      if (photo.url) await deleteFromS3(photo.url).catch(() => {});
      await photo.deleteOne();
      await audit(req, 'DELETE', { hard: true, userId: photo.userId }, photo._id);
      return res.json({ success: true, message: 'Photograph permanently removed' });
    }

    photo.isDeleted = true;
    photo.deletedAt = new Date();
    photo.deletedBy = req.admin?._id || null;
    await photo.save();
    await audit(req, 'DELETE', { hard: false, userId: photo.userId }, photo._id);
    return res.json({ success: true, message: 'Photograph removed' });
  } catch (error) {
    console.error('deletePhoto failed:', error);
    return res.status(500).json({ success: false, message: 'Could not remove the photograph' });
  }
};
