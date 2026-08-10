const mongoose = require('mongoose');

/**
 * Level 1 of the service taxonomy — Skin, Hair, Skin & Hair, Wellness,
 * Aesthetics, Consultations, Diagnostic Tests.
 *
 * A type groups treatment categories, which in turn hold the sub-categories
 * that guests actually book. It lives in the database rather than in code so
 * the clinic can rename one or change its order without a release, the same
 * way branches and categories already work.
 *
 * "Skin & Hair" is deliberately its own type rather than two tags — that is
 * how the clinic's own service list is written.
 */
const serviceTypeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'A type name is required'],
      unique: true,
      trim: true,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    description: {
      type: String,
      default: '',
      trim: true,
    },
    /** Drives the order of the filter chips in the app and the panel. */
    displayOrder: {
      type: Number,
      default: 0,
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    /** Kept in step by the category/consultation count sync. */
    categoryCount: {
      type: Number,
      default: 0,
    },
    treatmentCount: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true },
);

serviceTypeSchema.index({ displayOrder: 1, name: 1 });

module.exports = mongoose.model('ServiceType', serviceTypeSchema);
