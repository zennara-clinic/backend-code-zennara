const mongoose = require('mongoose');

/**
 * Reusable guest messages — Zenoti/ezConnect "Templates".
 *
 * A template has a channel, a body with {{placeholders}} and an optional
 * Twilio Content SID (WhatsApp business templates must be pre-approved by
 * Meta; outside the 24-hour reply window only those can be sent). The desk
 * picks one in the chat composer or from a booking; the placeholders are
 * filled from the guest / booking / centre.
 *
 * Placeholders: {{guestName}} {{firstName}} {{phone}} {{centre}} {{centrePhone}}
 * {{service}} {{date}} {{time}} {{doctor}} {{reference}} {{amountDue}} {{staff}}
 */
const messageTemplateSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  key: { type: String, required: true, unique: true, trim: true, lowercase: true },
  channel: { type: String, enum: ['whatsapp', 'email', 'sms', 'note'], default: 'whatsapp', index: true },
  category: { type: String, enum: ['appointment', 'billing', 'package', 'membership', 'marketing', 'general'], default: 'general', index: true },
  subject: { type: String, default: '', trim: true },
  body: { type: String, required: true },
  /** Pre-approved WhatsApp business template on Twilio (needed outside the 24h window). */
  twilioContentSid: { type: String, default: null, trim: true },
  /** Order of {{placeholders}} as the Twilio template expects them ({{1}}, {{2}} …). */
  contentVariables: { type: [String], default: [] },
  isActive: { type: Boolean, default: true, index: true },
  branchIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  createdByName: { type: String, default: null },
  updatedByName: { type: String, default: null },
  usageCount: { type: Number, default: 0 },
  lastUsedAt: { type: Date, default: null },
}, { timestamps: true });

const PLACEHOLDERS = ['guestName', 'firstName', 'phone', 'centre', 'centrePhone', 'service', 'date', 'time', 'doctor', 'reference', 'amountDue', 'staff', 'invoiceNumber', 'packageName', 'sessionsLeft', 'expiry', 'memberNumber'];

/** Fill {{placeholders}}; unknown ones are left blank rather than shown raw. */
messageTemplateSchema.statics.render = function (body, vars = {}) {
  return String(body || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k])));
};
messageTemplateSchema.statics.PLACEHOLDERS = PLACEHOLDERS;

module.exports = mongoose.model('MessageTemplate', messageTemplateSchema);
