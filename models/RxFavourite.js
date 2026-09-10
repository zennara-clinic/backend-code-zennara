const mongoose = require('mongoose');

/**
 * A prescription a dermatologist writes often, saved for one-tap reuse.
 *
 * Dermatology is repetitive by nature — the same acne set, the same melasma
 * set, the same post-laser aftercare — and retyping seven fields per medicine
 * for every guest is where prescribing errors come from. A favourite stores
 * the LINES, not a patient: no dose is applied to anyone until the doctor adds
 * it to a consultation and can still edit every field.
 *
 * `scope` decides who sees it. A favourite is the doctor's own by default;
 * `clinic` shares it with every dermatologist, which is how a centre agrees a
 * house protocol without a spreadsheet. Nothing here is a clinic *package* —
 * packages are priced products and live in the Package collection.
 */
const rxFavouriteItemSchema = new mongoose.Schema(
  {
    // Mirrors ConsultationNote's prescriptionItemSchema, minus the
    // per-patient fields (availableQuantity, refill tracking) which only mean
    // something once the line is attached to a real consultation.
    medicine: { type: String, required: true, trim: true },
    strength: { type: String, default: null, trim: true },
    formulation: { type: String, default: null, trim: true },
    dosage: { type: String, default: null, trim: true },
    frequency: { type: String, default: null, trim: true },
    duration: { type: String, default: null, trim: true },
    timing: { type: String, default: null, trim: true },
    instructions: { type: String, default: null, trim: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    isScheduleH: { type: Boolean, default: false },
    refillAfterDays: { type: Number, default: null },
  },
  { _id: false },
);

const rxFavouriteSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    /** "Acne", "Melasma", "Post-procedure" — how the shelf groups them. */
    category: { type: String, default: null, trim: true, maxlength: 60 },
    description: { type: String, default: null, trim: true, maxlength: 400 },
    items: {
      type: [rxFavouriteItemSchema],
      validate: [(v) => v.length > 0, 'A favourite needs at least one medicine.'],
    },
    /** Skin-care / lifestyle advice that goes with the set, copied onto the note. */
    advice: { type: String, default: null, trim: true, maxlength: 2000 },

    /** The Admin (dermatologist) who saved it. */
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true, index: true },
    ownerName: { type: String, default: null, trim: true },
    scope: { type: String, enum: ['mine', 'clinic'], default: 'mine', index: true },

    /** Soft delete: a favourite that shaped past prescriptions is not erased. */
    isActive: { type: Boolean, default: true, index: true },
    /** How often it has actually been used — the shelf sorts by this. */
    useCount: { type: Number, default: 0 },
    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

rxFavouriteSchema.index({ ownerId: 1, isActive: 1, useCount: -1 });
// One dermatologist cannot keep two live favourites with the same name; the
// shelf would show two identical cards and nobody could tell them apart.
rxFavouriteSchema.index(
  { ownerId: 1, name: 1 },
  { unique: true, partialFilterExpression: { isActive: true } },
);

module.exports = mongoose.model('RxFavourite', rxFavouriteSchema);
