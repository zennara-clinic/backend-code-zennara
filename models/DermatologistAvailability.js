const mongoose = require('mongoose');

const dermatologistAvailabilitySchema = new mongoose.Schema(
  {
    // Stable ID shared with the mobile dermatologist profile (for example,
    // "rickson-pereira"). It deliberately does not depend on a display name.
    doctorId: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    branches: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch',
        required: true,
      },
    ],
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null,
    },
  },
  { timestamps: true },
);

dermatologistAvailabilitySchema.index({ branches: 1, isActive: 1 });

module.exports = mongoose.model(
  'DermatologistAvailability',
  dermatologistAvailabilitySchema,
);
