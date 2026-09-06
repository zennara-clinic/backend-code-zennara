const mongoose = require('mongoose');

/**
 * Atomic sequence numbers (invoice / receipt numbers per centre and year).
 *
 * `next('invoice:<branchId>:26')` → 1, 2, 3 … with one findOneAndUpdate, so two
 * desks closing a bill at the same instant can never share a number. Nothing
 * here is ever decremented: a voided invoice keeps its number (as in Zenoti),
 * which is what the GST audit trail requires.
 */
const counterSchema = new mongoose.Schema({
  _id: { type: String },
  seq: { type: Number, default: 0 },
}, { versionKey: false });

counterSchema.statics.next = async function (key) {
  const doc = await this.findOneAndUpdate({ _id: key }, { $inc: { seq: 1 } }, { new: true, upsert: true, setDefaultsOnInsert: true }).lean();
  return doc.seq;
};

/** Peek without consuming (for previews). */
counterSchema.statics.peek = async function (key) {
  const doc = await this.findById(key).lean();
  return (doc?.seq || 0) + 1;
};

module.exports = mongoose.model('Counter', counterSchema);
