const test = require('node:test');
const assert = require('node:assert');
const { sanitizeAnnotations, MAX_MARKS } = require('../utils/photoAnnotations');

const admin = { _id: '64b000000000000000000001', name: 'Dr Test' };

test('a circle, a box, an arrow and a freehand line survive with their notes', () => {
  const out = sanitizeAnnotations([
    { kind: 'ellipse', x: 0.2, y: 0.3, w: 0.1, h: 0.12, color: '#B42318', width: 4, note: 'Active papule' },
    { kind: 'rect', x: 0.5, y: 0.5, w: 0.2, h: 0.1 },
    { kind: 'arrow', points: [[0.1, 0.1], [0.4, 0.4], [0.3, 0.3]] },
    { kind: 'pen', points: [[0.1, 0.1], [0.12, 0.13], [0.15, 0.2]] },
  ], [], admin);
  assert.strictEqual(out.length, 4);
  assert.strictEqual(out[0].note, 'Active papule');
  assert.strictEqual(out[1].note, '', 'a note is optional');
  assert.deepStrictEqual(out[2].points, [[0.1, 0.1], [0.3, 0.3]], 'an arrow keeps tail and tip');
  assert.strictEqual(out[3].points.length, 3);
  assert.strictEqual(out[0].createdByName, 'Dr Test');
});

test('geometry is clamped to the photo and junk is dropped', () => {
  const out = sanitizeAnnotations([
    { kind: 'ellipse', x: -1, y: 0.9, w: 5, h: 5 },
    { kind: 'hexagon', x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
    { kind: 'rect', x: 'a', y: 0, w: 0.1, h: 0.1 },
    { kind: 'pen', points: [[0.1, 0.1]] },
    { kind: 'rect', x: 0.1, y: 0.1, w: 0, h: 0 },
    null,
  ], [], admin);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].x, 0);
  assert.ok(out[0].y + out[0].h <= 1);
  assert.ok(out[0].x + out[0].w <= 1);
});

test('colour, width and note length are bounded', () => {
  const [m] = sanitizeAnnotations([{ kind: 'rect', x: 0.1, y: 0.1, w: 0.1, h: 0.1, color: 'red;background:url(x)', width: 99, note: 'x'.repeat(900) }], [], admin);
  assert.strictEqual(m.color, '#D92D20');
  assert.strictEqual(m.width, 12);
  assert.strictEqual(m.note.length, 500);
});

test('an existing mark keeps its author when someone else edits the note', () => {
  const existing = [{ _id: '64b0000000000000000000aa', kind: 'ellipse', createdBy: 'orig', createdByName: 'Dr First', createdAt: new Date('2026-09-01') }];
  const [m] = sanitizeAnnotations([{ _id: '64b0000000000000000000aa', kind: 'ellipse', x: 0.1, y: 0.1, w: 0.1, h: 0.1, note: 'Edited' }], existing, admin);
  assert.strictEqual(m.createdByName, 'Dr First');
  assert.strictEqual(String(m._id), '64b0000000000000000000aa');
  assert.strictEqual(m.note, 'Edited');
});

test('not a list is refused; too many marks are capped', () => {
  assert.strictEqual(sanitizeAnnotations('nope', [], admin), null);
  const many = Array.from({ length: MAX_MARKS + 10 }, () => ({ kind: 'rect', x: 0.1, y: 0.1, w: 0.1, h: 0.1 }));
  assert.strictEqual(sanitizeAnnotations(many, [], admin).length, MAX_MARKS);
  assert.deepStrictEqual(sanitizeAnnotations([], [], admin), [], 'an empty list clears every mark');
});
