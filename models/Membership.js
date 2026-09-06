const mongoose = require('mongoose');

/**
 * A membership plan — Zenoti's "Manage memberships" row.
 *
 * Zennara's memberships are one-time paid tiers (non-recurring) that give a
 * percentage off services and/or products for a period, and some carry
 * service credits (the MVP plans: "MVP-2026 Service Credit Used" on the
 * bill). Member numbers are prefix + running seed (MVPJH-202). Plans mirrored
 * from Zenoti keep their id; their discount rules are filled in here because
 * the Zenoti API does not expose them.
 */
const membershipSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  code: { type: String, required: true, trim: true, uppercase: true, unique: true },
  description: { type: String, default: '', trim: true },
  membershipType: { type: String, enum: ['non_recurring', 'recurring'], default: 'non_recurring' },
  /** Member number = prefix + seed; seed is the NEXT number to issue. */
  prefix: { type: String, default: '', trim: true, uppercase: true },
  seed: { type: Number, default: 1, min: 1 },
  price: { type: Number, default: 0, min: 0 },
  taxPercent: { type: Number, default: 18, min: 0 },
  priceIncludesTax: { type: Boolean, default: true },
  validityMonths: { type: Number, default: 12, min: 1 },
  /** What the member gets. */
  discounts: {
    servicesPercent: { type: Number, default: 0, min: 0, max: 100 },
    productsPercent: { type: Number, default: 0, min: 0, max: 100 },
    packagesPercent: { type: Number, default: 0, min: 0, max: 100 },
  },
  credits: [{
    _id: false,
    serviceId: { type: String, required: true },   // Consultation.id (slug) or _id
    serviceName: { type: String, default: '' },
    qty: { type: Number, default: 1, min: 1 },
  }],
  /** Free-text extras printed on the card / agreement. */
  benefits: { type: [String], default: [] },
  /** Sold / honoured at (empty = every centre). */
  branchIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  isActive: { type: Boolean, default: true, index: true },
  /** The plan the app's Zen Membership card sells (at most one). */
  isAppDefault: { type: Boolean, default: false },
  terms: { type: String, default: '', trim: true },
  source: { type: String, enum: ['panel', 'zenoti'], default: 'panel', index: true },
  zenotiMembershipId: { type: String, default: null, trim: true, lowercase: true, index: true },
  zenotiVersionId: { type: String, default: null, trim: true, lowercase: true },
  zenotiRaw: { type: mongoose.Schema.Types.Mixed, default: null },
  zenotiSyncedAt: { type: Date, default: null },
  membersCount: { type: Number, default: 0 },
}, { timestamps: true });

/** Issue the next member number atomically. */
membershipSchema.statics.nextMemberNumber = async function (membershipId) {
  const doc = await this.findOneAndUpdate({ _id: membershipId }, { $inc: { seed: 1 } }, { new: false });
  if (!doc) return null;
  return `${doc.prefix || doc.code || ''}${doc.seed}`;
};

membershipSchema.methods.priceAt = function() {
  const inclusive = this.priceIncludesTax !== false;
  const t = Number(this.taxPercent) || 0;
  const base = inclusive ? +(this.price / (1 + t / 100)).toFixed(2) : this.price;
  const tax = +(base * t / 100).toFixed(2);
  return { price: this.price, taxPercent: t, priceIncludesTax: inclusive, base, tax, total: inclusive ? this.price : +(this.price + tax).toFixed(2) };
};

module.exports = mongoose.model('Membership', membershipSchema);
