const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const ConsultationNote = require('../models/ConsultationNote');
const { signedContent } = require('../utils/noteSignature');

/**
 * A signature is revoked only when what was signed changes. Uses the real
 * schema (no database): a note is hydrated the way findOne returns it, then
 * the panel's next save is applied to it.
 */

// A signed note as stored before strength/timing/refill existed on a line.
const stored = () => ConsultationNote.hydrate({
  _id: new mongoose.Types.ObjectId(),
  bookingId: new mongoose.Types.ObjectId(),
  userId: new mongoose.Types.ObjectId(),
  doctorId: 'test-doctor',
  status: 'Completed',
  prescriptionSigned: true,
  complaint: 'Acne on cheeks',
  examination: 'Papules',
  primaryDiagnosis: 'Acne vulgaris',
  prescription: [{ medicine: 'Tab Doxybond LB', dosage: '1 tab', frequency: 'OD', duration: '30 days', refillReminderSentAt: new Date('2026-09-01') }],
  followUpDate: new Date('2026-10-01'),
});

// What the panel sends back: every line field, blanks as empty strings.
const panelLine = (over = {}) => ({
  medicine: 'Tab Doxybond LB', strength: '', formulation: '', dosage: '1 tab', frequency: 'OD',
  duration: '30 days', timing: '', instructions: '', productId: null, isScheduleH: false, ...over,
});

test('re-sending the same note keeps the signature, even with newer line fields and a sent reminder', () => {
  const note = stored();
  const before = signedContent(note);
  note.complaint = 'Acne on cheeks ';
  note.prescription = [panelLine()];
  note.followUpDate = new Date('2026-10-01');
  note.secondaryDiagnosis = '';
  assert.strictEqual(signedContent(note), before);
});

test('a changed dose changes the signed content', () => {
  const note = stored();
  const before = signedContent(note);
  note.prescription = [panelLine({ dosage: '2 tabs' })];
  assert.notStrictEqual(signedContent(note), before);
});

test('findings the guest reads are covered, not only medicines', () => {
  for (const [field, value] of [['complaint', 'Acne and melasma'], ['examination', 'Nodules'], ['precautions', 'Avoid sun']]) {
    const note = stored();
    const before = signedContent(note);
    note[field] = value;
    assert.notStrictEqual(signedContent(note), before, field);
  }
});

test('a removed line or a moved follow-up changes the signed content', () => {
  const removed = stored();
  const b1 = signedContent(removed);
  removed.prescription = [];
  assert.notStrictEqual(signedContent(removed), b1);

  const moved = stored();
  const b2 = signedContent(moved);
  moved.followUpDate = new Date('2026-10-15');
  assert.notStrictEqual(signedContent(moved), b2);
});
