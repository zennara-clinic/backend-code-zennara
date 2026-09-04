const mongoose = require('mongoose');

/**
 * An admin-built consultation form.
 *
 * PreConsultForm and PatientConsentForm are fixed schemas: every new question
 * the clinic wants to ask is a model change, a migration and a release. This
 * collection lets the clinic define its own forms — fields, order, whether
 * each is required, and which treatments or branches they apply to.
 *
 * The two fixed forms are NOT replaced. They carry encrypted health data and
 * are wired into the app's own screens; a template-driven form is an addition
 * for everything else. Answers land in FormSubmission below.
 *
 * Templates are versioned rather than edited in place once they have
 * submissions: an answer must always be readable against the questions that
 * were actually asked, and silently renaming a field would rewrite history.
 */

const optionSchema = new mongoose.Schema(
  { label: { type: String, required: true, trim: true }, value: { type: String, required: true, trim: true } },
  { _id: false },
);

const fieldSchema = new mongoose.Schema(
  {
    /** Stable machine name. Answers are keyed on this, so it must not change. */
    key: {
      type: String,
      required: true,
      trim: true,
      match: [/^[a-z][a-z0-9_]{0,49}$/, 'A field key must be lowercase letters, digits and underscores'],
    },
    label: { type: String, required: true, trim: true },
    helpText: { type: String, default: '', trim: true },
    placeholder: { type: String, default: '', trim: true },
    type: {
      type: String,
      enum: ['text', 'textarea', 'number', 'date', 'select', 'multiselect', 'checkbox', 'radio', 'photo'],
      default: 'text',
    },
    /** Only meaningful for select / multiselect / radio. */
    options: { type: [optionSchema], default: [] },
    required: { type: Boolean, default: false },
    /** Position in the form. Reordering is a change to this, nothing else. */
    order: { type: Number, default: 0 },
    /**
     * Marks a field as clinical, so a submission carrying it is treated as
     * health data by anything that exports or displays submissions.
     */
    sensitive: { type: Boolean, default: false },
  },
  { _id: false },
);

const formTemplateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, index: true, trim: true },
    description: { type: String, default: '', trim: true },

    fields: { type: [fieldSchema], default: [] },

    /* --- Assignment: where this form is asked ---------------------------- */
    /** Consultation category names, e.g. "Laser Treatments". Empty = all. */
    consultationCategories: { type: [String], default: [] },
    /** Specific treatments. Empty = every treatment in the categories above. */
    treatmentIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Consultation' }],
    /** Branches. Empty = every branch, which is the sensible default. */
    branchIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Branch' }],

    isActive: { type: Boolean, default: false, index: true },
    displayOrder: { type: Number, default: 0 },

    /**
     * Bumped whenever the fields change after a submission exists. A
     * submission records the version it answered, so an old answer is always
     * read against the questions that were actually asked.
     */
    version: { type: Number, default: 1 },
    submissionCount: { type: Number, default: 0 },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
  },
  { timestamps: true },
);

/** Keys have to be unique inside one form or answers would collide. */
formTemplateSchema.pre('validate', function (next) {
  const seen = new Set();
  for (const f of this.fields || []) {
    if (seen.has(f.key)) {
      return next(new Error(`Duplicate field key "${f.key}" — each field needs its own key.`));
    }
    seen.add(f.key);
  }
  // Choice fields without choices are a silent dead end in the form.
  for (const f of this.fields || []) {
    if (['select', 'multiselect', 'radio'].includes(f.type) && !(f.options || []).length) {
      return next(new Error(`Field "${f.label || f.key}" is a ${f.type} but has no options.`));
    }
  }
  return next();
});

formTemplateSchema.index({ isActive: 1, displayOrder: 1 });

const submissionSchema = new mongoose.Schema(
  {
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: 'FormTemplate', required: true, index: true },
    templateSlug: { type: String, default: '', trim: true },
    /** The version answered, so the questions can be reconstructed exactly. */
    templateVersion: { type: Number, default: 1 },

    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', default: null, index: true },
    branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },

    /** field key → answer. Mixed, because a field may be text, a number or a list. */
    answers: { type: mongoose.Schema.Types.Mixed, default: {} },

    status: { type: String, enum: ['draft', 'submitted'], default: 'draft', index: true },
    submittedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Newest first, like every other history list in the system.
submissionSchema.index({ userId: 1, createdAt: -1 });
submissionSchema.index({ templateId: 1, createdAt: -1 });

module.exports = {
  FormTemplate: mongoose.model('FormTemplate', formTemplateSchema),
  FormSubmission: mongoose.model('FormSubmission', submissionSchema),
};
