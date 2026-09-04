/**
 * Form templates — the admin-built consultation forms.
 *
 * The rule that shapes this file: once a template has submissions, its
 * questions become history. Editing the fields bumps `version` rather than
 * rewriting what was asked, and a field key is never renamed in place — an
 * answer keyed on `skin_type` must still mean skin type in a year.
 */
const { FormTemplate, FormSubmission } = require('../models/FormTemplate');
const AdminAuditLog = require('../models/AdminAuditLog');

const slugify = (v) => String(v || '')
  .toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

async function audit(req, details, resourceId, status = 'SUCCESS') {
  await AdminAuditLog.logAction({
    adminId: req.admin?._id,
    adminEmail: req.admin?.email,
    action: 'FORM_TEMPLATE_UPDATED',
    resource: 'CLINICAL',
    resourceId,
    details,
    ipAddress: req.adminIp || req.ip,
    userAgent: req.adminUserAgent,
    status,
  }).catch(() => {});
}

/** GET /api/form-templates */
exports.list = async (req, res) => {
  try {
    const { isActive, search } = req.query;
    const query = {};
    if (isActive !== undefined) query.isActive = isActive === 'true';
    if (search) {
      const rx = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [{ name: rx }, { description: rx }];
    }
    const templates = await FormTemplate.find(query)
      .sort({ displayOrder: 1, name: 1 })
      .lean();
    return res.json({ success: true, count: templates.length, data: templates });
  } catch (error) {
    console.error('form template list failed:', error);
    return res.status(500).json({ success: false, message: 'Could not load the forms' });
  }
};

/** GET /api/form-templates/:id */
exports.get = async (req, res) => {
  try {
    const template = await FormTemplate.findById(req.params.id)
      .populate('treatmentIds', 'name category')
      .populate('branchIds', 'name')
      .lean();
    if (!template) return res.status(404).json({ success: false, message: 'Form not found' });
    return res.json({ success: true, data: template });
  } catch (error) {
    console.error('form template get failed:', error);
    return res.status(500).json({ success: false, message: 'Could not load the form' });
  }
};

/** POST /api/form-templates — always created inactive. */
exports.create = async (req, res) => {
  try {
    const { name, description, fields, consultationCategories, treatmentIds, branchIds, displayOrder } = req.body || {};
    if (!String(name || '').trim()) {
      return res.status(400).json({ success: false, message: 'Give the form a name' });
    }

    const slug = slugify(name);
    if (await FormTemplate.exists({ slug })) {
      return res.status(409).json({ success: false, message: 'A form with that name already exists' });
    }

    const template = await FormTemplate.create({
      name: String(name).trim(),
      slug,
      description: description || '',
      // Order is stored, not inferred from array position, so a later reorder
      // is one number per field rather than a rewrite of the whole list.
      fields: (Array.isArray(fields) ? fields : []).map((f, i) => ({ ...f, order: Number(f.order ?? i) })),
      consultationCategories: Array.isArray(consultationCategories) ? consultationCategories : [],
      treatmentIds: Array.isArray(treatmentIds) ? treatmentIds : [],
      branchIds: Array.isArray(branchIds) ? branchIds : [],
      displayOrder: Number(displayOrder) || 0,
      // Never live on creation — it has to be previewed first.
      isActive: false,
      createdBy: req.admin?._id || null,
    });

    await audit(req, { created: template.name, fields: template.fields.length }, template._id);
    return res.status(201).json({ success: true, data: template });
  } catch (error) {
    if (error.name === 'ValidationError' || /Duplicate field key|has no options/.test(error.message)) {
      return res.status(400).json({ success: false, message: error.message });
    }
    console.error('form template create failed:', error);
    return res.status(500).json({ success: false, message: 'Could not create the form' });
  }
};

/**
 * PUT /api/form-templates/:id
 *
 * Changing the fields on a template that already has submissions bumps the
 * version. Old submissions keep the version they answered, so their answers
 * stay readable against the right questions.
 */
exports.update = async (req, res) => {
  try {
    const template = await FormTemplate.findById(req.params.id);
    if (!template) return res.status(404).json({ success: false, message: 'Form not found' });

    const { name, description, fields, consultationCategories, treatmentIds, branchIds, isActive, displayOrder } = req.body || {};

    if (name !== undefined && String(name).trim() && String(name).trim() !== template.name) {
      const slug = slugify(name);
      if (await FormTemplate.exists({ slug, _id: { $ne: template._id } })) {
        return res.status(409).json({ success: false, message: 'A form with that name already exists' });
      }
      template.name = String(name).trim();
      template.slug = slug;
    }
    if (description !== undefined) template.description = description;
    if (consultationCategories !== undefined) template.consultationCategories = consultationCategories || [];
    if (treatmentIds !== undefined) template.treatmentIds = treatmentIds || [];
    if (branchIds !== undefined) template.branchIds = branchIds || [];
    if (displayOrder !== undefined) template.displayOrder = Number(displayOrder) || 0;
    if (isActive !== undefined) template.isActive = Boolean(isActive);

    if (Array.isArray(fields)) {
      const before = JSON.stringify(template.fields.map((f) => ({ k: f.key, t: f.type, r: f.required })));
      template.fields = fields.map((f, i) => ({ ...f, order: Number(f.order ?? i) }));
      const after = JSON.stringify(template.fields.map((f) => ({ k: f.key, t: f.type, r: f.required })));
      if (before !== after && template.submissionCount > 0) template.version += 1;
    }

    template.updatedBy = req.admin?._id || null;
    await template.save();

    await audit(req, { updated: template.name, version: template.version, active: template.isActive }, template._id);
    return res.json({ success: true, data: template });
  } catch (error) {
    if (error.name === 'ValidationError' || /Duplicate field key|has no options/.test(error.message)) {
      return res.status(400).json({ success: false, message: error.message });
    }
    console.error('form template update failed:', error);
    return res.status(500).json({ success: false, message: 'Could not update the form' });
  }
};

/**
 * DELETE /api/form-templates/:id
 *
 * A template with submissions is deactivated, never removed — deleting it
 * would orphan real patient answers.
 */
exports.remove = async (req, res) => {
  try {
    const template = await FormTemplate.findById(req.params.id);
    if (!template) return res.status(404).json({ success: false, message: 'Form not found' });

    const submissions = await FormSubmission.countDocuments({ templateId: template._id });
    if (submissions > 0) {
      template.isActive = false;
      await template.save();
      await audit(req, { deactivatedInsteadOfDeleted: template.name, submissions }, template._id);
      return res.json({
        success: true,
        message: `This form has ${submissions} submission(s), so it has been deactivated rather than deleted — the answers are kept.`,
        data: template,
      });
    }

    await template.deleteOne();
    await audit(req, { deleted: template.name }, template._id);
    return res.json({ success: true, message: 'Form deleted' });
  } catch (error) {
    console.error('form template delete failed:', error);
    return res.status(500).json({ success: false, message: 'Could not delete the form' });
  }
};

/** GET /api/form-templates/:id/submissions — newest first. */
exports.submissions = async (req, res) => {
  try {
    const { page = 1, limit = 50, status } = req.query;
    const perPage = Math.min(Number(limit) || 50, 200);
    const pageNo = Math.max(1, Number(page) || 1);

    const query = { templateId: req.params.id };
    if (status) query.status = status;

    const [rows, total] = await Promise.all([
      FormSubmission.find(query)
        .sort({ createdAt: -1 })
        .skip((pageNo - 1) * perPage)
        .limit(perPage)
        .populate('userId', 'fullName email phone patientId')
        .populate('bookingId', 'referenceNumber eventAt')
        .lean(),
      FormSubmission.countDocuments(query),
    ]);

    return res.json({ success: true, count: rows.length, total, data: rows });
  } catch (error) {
    console.error('form submissions failed:', error);
    return res.status(500).json({ success: false, message: 'Could not load the submissions' });
  }
};

/**
 * POST /api/form-templates/:id/submissions — a patient answers.
 *
 * Validation is driven by the template, so a required question cannot be
 * skipped and an unknown key cannot be smuggled into the answers.
 */
exports.submit = async (req, res) => {
  try {
    const template = await FormTemplate.findById(req.params.id).lean();
    if (!template || !template.isActive) {
      return res.status(404).json({ success: false, message: 'This form is not available' });
    }

    const answers = (req.body?.answers && typeof req.body.answers === 'object') ? req.body.answers : {};
    const known = new Map((template.fields || []).map((f) => [f.key, f]));

    const missing = (template.fields || [])
      .filter((f) => f.required)
      .filter((f) => {
        const v = answers[f.key];
        return v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
      })
      .map((f) => f.label);
    if (missing.length) {
      return res.status(400).json({ success: false, message: `Please answer: ${missing.join(', ')}` });
    }

    // Keep only keys the template declares — an unknown key is either a stale
    // client or an attempt to store something the form never asked for.
    const clean = {};
    for (const [key, value] of Object.entries(answers)) if (known.has(key)) clean[key] = value;

    const submission = await FormSubmission.create({
      templateId: template._id,
      templateSlug: template.slug,
      templateVersion: template.version,
      userId: req.user?._id || req.body.userId,
      bookingId: req.body.bookingId || null,
      branchId: req.body.branchId || null,
      answers: clean,
      status: 'submitted',
      submittedAt: new Date(),
    });

    await FormTemplate.updateOne({ _id: template._id }, { $inc: { submissionCount: 1 } });
    return res.status(201).json({ success: true, data: submission });
  } catch (error) {
    console.error('form submit failed:', error);
    return res.status(500).json({ success: false, message: 'Could not save your answers' });
  }
};

/**
 * GET /api/form-templates/for-booking/:bookingId
 * Which active forms apply to one appointment — branch and treatment aware.
 */
exports.forBooking = async (req, res) => {
  try {
    const Booking = require('../models/Booking');
    const booking = await Booking.findById(req.params.bookingId)
      .select('branchId consultationId')
      .populate('consultationId', 'category')
      .lean();
    if (!booking) return res.status(404).json({ success: false, message: 'Appointment not found' });

    const category = booking.consultationId?.category || null;
    const templates = await FormTemplate.find({ isActive: true }).sort({ displayOrder: 1 }).lean();

    // An empty assignment list means "everywhere" — that is the default and
    // must not be read as "nowhere".
    const applies = templates.filter((t) => {
      const branchOk = !t.branchIds?.length || t.branchIds.some((b) => String(b) === String(booking.branchId));
      const categoryOk = !t.consultationCategories?.length
        || (category && t.consultationCategories.includes(category));
      const treatmentOk = !t.treatmentIds?.length
        || t.treatmentIds.some((id) => String(id) === String(booking.consultationId?._id));
      return branchOk && categoryOk && treatmentOk;
    });

    return res.json({ success: true, count: applies.length, data: applies });
  } catch (error) {
    console.error('forBooking failed:', error);
    return res.status(500).json({ success: false, message: 'Could not resolve the forms for this appointment' });
  }
};
