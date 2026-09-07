/**
 * A phone number that reaches a customer's screen must be a phone number.
 *
 * Zenoti models a phone as an object — { country_id, number, display_number } —
 * and the centre sync used to String() it, storing the literal text
 * "[object Object]" on six of the seven branches. The app printed that on the
 * "call the clinic" line and offered to dial it.
 *
 * Two guards, tested here: the extractor reads the number out of Zenoti's
 * object, and the model refuses to store anything that is not number-like even
 * if some future caller forgets.
 */
const test = require('node:test');
const assert = require('node:assert');
const Branch = require('../models/Branch');
const { phoneText } = require('../services/zenotiCenterSyncService');

const phoneErrors = (phone) => {
  const err = new Branch({ name: 'T', contact: { phone, email: 'a@b.com' } }).validateSync();
  return Object.keys(err?.errors || {}).filter((k) => k.startsWith('contact.phone'));
};

test('phoneText reads the number out of Zenoti\'s phone object', () => {
  assert.equal(phoneText({ country_id: 95, number: '7070701099', display_number: '7070701099' }), '7070701099');
  assert.equal(phoneText({ number: '8977759580' }), '8977759580');
  assert.equal(phoneText('7075505891'), '7075505891');
  assert.equal(phoneText(9876543210), '9876543210');
});

test('phoneText never yields the stringified-object text', () => {
  assert.equal(phoneText({}), null);
  assert.equal(phoneText({ country_id: 95 }), null);
  assert.equal(phoneText('[object Object]'), null);
  assert.equal(phoneText(null), null);
  assert.equal(phoneText(undefined), null);
  assert.equal(phoneText(''), null);
});

test('a branch cannot store "[object Object]" as a phone number', () => {
  assert.equal(phoneErrors(['7070701099']).length, 0, 'a real number is accepted');
  assert.ok(phoneErrors(['[object Object]']).length > 0, 'the bug is rejected');
  assert.ok(phoneErrors(['']).length > 0, 'blank is rejected');
  assert.ok(phoneErrors(['abc']).length > 0, 'letters are rejected');
});
