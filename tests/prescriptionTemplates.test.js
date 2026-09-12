const test = require('node:test');
const assert = require('node:assert');
const {
  TEMPLATES, templateMeta, buildView, renderPrescriptionHtml, esc,
} = require('../utils/prescriptionTemplates');

/**
 * The three printed designs read one view and must agree on what they show.
 * Pure: no database, no Mongoose document — the view is built from plain
 * objects the way the email path hands them over.
 */

const fullNote = () => ({
  prescriptionTemplate: 'modern',
  completedAt: new Date('2026-09-03T10:42:00Z'),
  prescriptionSigned: true,
  prescriptionSignedAt: new Date('2026-09-03T10:42:00Z'),
  prescriptionSignedByName: 'Dr Rickson',
  prescriptionSignedByRegistration: 'TSMC 12345',
  doctorName: 'Dr Rickson',
  primaryDiagnosis: 'Acne vulgaris',
  secondaryDiagnosis: 'Post-inflammatory hyperpigmentation',
  complaint: 'Pimples on both cheeks for 3 months',
  examination: 'Papules & pustules, no cysts',
  assessment: 'Moderate inflammatory acne',
  plan: 'Oral + topical, review in 4 weeks',
  prescription: [
    { medicine: '<b>x</b>', strength: '100 mg', formulation: 'Tab', dosage: '1 tab', frequency: 'OD', duration: '14 days', timing: 'Night', instructions: 'After food', isScheduleH: true },
    { medicine: 'Adapalene', strength: '0.1%', formulation: 'Gel', dosage: 'Pea-sized', frequency: 'HS', duration: '2 months', instructions: 'Thin layer' },
  ],
  assignedServices: [{ name: 'Chemical peel', sessions: 3 }],
  skinCareAdvice: 'Sunscreen SPF 50 every morning',
  lifestyleAdvice: 'Sleep 7 hours',
  precautions: 'Avoid picking',
  followUpDate: new Date('2026-10-01'),
});

const guest = () => ({
  fullName: 'Asha Rao', guestCode: 'ZENFD637', patientId: 'ZEN12345',
  dateOfBirth: '12/05/1990', gender: 'Female', drugAllergies: 'Sulpha drugs',
});

const booking = () => ({
  preferredLocation: 'Jubilee Hills',
  confirmedDate: new Date('2026-09-03'),
  consultationId: { name: 'Dermatology consultation' },
});

const fullView = () => buildView({ note: fullNote(), patient: guest(), booking: booking() });

test('three templates, with picker metadata for each', () => {
  assert.deepStrictEqual(TEMPLATES, ['classic', 'modern', 'minimal']);
  const meta = templateMeta();
  assert.deepStrictEqual(meta.map((m) => m.key), TEMPLATES);
  for (const m of meta) {
    assert.ok(m.name && m.tagline, `${m.key} needs a name and tagline`);
  }
});

test('buildView derives age, guest code, allergies, service and hasScheduleH', () => {
  const v = fullView();
  assert.strictEqual(v.guestName, 'Asha Rao');
  assert.strictEqual(v.guestCode, 'ZENFD637'); // Zenoti code wins over patientId
  assert.ok(v.age >= 36, `age derived from 12/05/1990, got ${v.age}`);
  assert.strictEqual(v.gender, 'Female');
  assert.strictEqual(v.allergies, 'Sulpha drugs');
  assert.strictEqual(v.centre, 'Jubilee Hills');
  assert.strictEqual(v.service, 'Dermatology consultation');
  assert.strictEqual(v.doctorName, 'Dr Rickson');
  assert.strictEqual(v.registration, 'TSMC 12345');
  assert.strictEqual(v.signed, true);
  assert.strictEqual(v.template, 'modern');
  assert.strictEqual(v.hasScheduleH, true);
  assert.strictEqual(v.items.length, 2);
  assert.strictEqual(v.items[0].isScheduleH, true);
  // 14 days after the completion date
  assert.strictEqual(v.items[0].refillDueAt.toISOString(), '2026-09-17T10:42:00.000Z');
  assert.deepStrictEqual(v.assignedServices, [{ name: 'Chemical peel', sessions: 3 }]);
  assert.deepStrictEqual(v.advice, { skinCare: 'Sunscreen SPF 50 every morning', lifestyle: 'Sleep 7 hours', precautions: 'Avoid picking' });
});

test('buildView reads age from a Date-cast date of birth as well', () => {
  const v = buildView({ note: {}, patient: { fullName: 'A', dateOfBirth: new Date('1990-05-12').toString() } });
  assert.ok(v.age >= 35 && v.age <= 40, `unexpected age ${v.age}`);
});

test('buildView falls back to the populated note references and to classic', () => {
  const v = buildView({
    note: { ...fullNote(), prescriptionTemplate: 'not-a-design', userId: guest(), bookingId: booking() },
  });
  assert.strictEqual(v.template, 'classic');
  assert.strictEqual(v.guestName, 'Asha Rao');
  assert.strictEqual(v.centre, 'Jubilee Hills');
});

test('an empty view has every key and no Schedule H', () => {
  const v = buildView({});
  assert.strictEqual(v.guestName, 'Guest');
  assert.strictEqual(v.age, null);
  assert.strictEqual(v.hasScheduleH, false);
  assert.deepStrictEqual(v.items, []);
  assert.strictEqual(v.signed, false);
  assert.strictEqual(v.template, 'classic');
});

for (const template of TEMPLATES) {
  test(`${template}: renders a full view and an empty one without throwing`, () => {
    const full = renderPrescriptionHtml(fullView(), { template });
    const empty = renderPrescriptionHtml(buildView({}), { template });
    for (const html of [full, empty]) {
      assert.ok(html.startsWith('<!DOCTYPE html>'));
      assert.ok(html.includes('</html>'));
      assert.ok(html.includes('fonts.googleapis.com'), 'loads Cormorant Garamond + Manrope');
      assert.ok(html.includes('@page'), 'has print CSS');
      assert.ok(/<img class="rx-logo" src="data:image\/png;base64,/.test(html), 'the clinic logo heads the page, inlined');
      assert.ok(html.includes('alt="Zennara"'), 'the logo names the clinic when images are off');
    }
    assert.ok(full.includes('Asha Rao'), 'guest name');
    assert.ok(full.includes('ZENFD637'), 'guest code');
    assert.ok(full.includes('TSMC 12345'), 'registration');
    assert.ok(full.includes('Chemical peel'), 'treatments advised');
    assert.ok(full.includes('Schedule H'), 'Schedule H footer when a line is Sch H');
    assert.ok(!empty.includes('Schedule H'), 'no Schedule H footer without one');
  });

  test(`${template}: escapes every value`, () => {
    const html = renderPrescriptionHtml(fullView(), { template });
    assert.ok(!html.includes('<b>x</b>'), 'a medicine named <b>x</b> never appears raw');
    assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'));
    const hostile = buildView({
      note: { complaint: '<script>alert(1)</script>', prescription: [{ medicine: 'ok', instructions: '"quoted" & <i>' }] },
      patient: { fullName: '<img src=x onerror=1>' },
      booking: { preferredLocation: '</style><b>' },
    });
    const out = renderPrescriptionHtml(hostile, { template });
    assert.ok(!out.includes('<script>'));
    assert.ok(!out.includes('<img src=x'));
    assert.ok(!out.includes('</style><b>'));
    assert.ok(!out.includes('<i>'));
  });

  test(`${template}: the preview ribbon appears only for a draft`, () => {
    const signed = fullView();
    assert.ok(!renderPrescriptionHtml(signed, { template }).includes('rx-ribbon"'), 'signed → no ribbon');
    assert.ok(renderPrescriptionHtml(signed, { template, draft: true }).includes('Preview — not signed'), 'draft=true forces it');
    const unsigned = buildView({ note: { ...fullNote(), prescriptionSigned: false } });
    assert.ok(renderPrescriptionHtml(unsigned, { template }).includes('Preview — not signed'), 'unsigned defaults to a preview');
    assert.ok(!renderPrescriptionHtml(unsigned, { template, draft: false }).includes('Preview — not signed'));
  });
}

test('renderPrescriptionHtml defaults to the view template and tolerates an unknown one', () => {
  const v = fullView();
  assert.ok(renderPrescriptionHtml(v).includes('rx-band'), 'modern (from the view) has the header band');
  assert.ok(renderPrescriptionHtml(v, { template: 'bogus' }).includes('rx-rx'), 'unknown → classic');
});

test('esc covers the characters that break attributes and tags', () => {
  assert.strictEqual(esc('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  assert.strictEqual(esc(null), '');
});

test('switching the template on a signed note is not a clinical change', () => {
  const mongoose = require('mongoose');
  const ConsultationNote = require('../models/ConsultationNote');
  const { signedContent } = require('../utils/noteSignature');
  const note = ConsultationNote.hydrate({
    _id: new mongoose.Types.ObjectId(),
    bookingId: new mongoose.Types.ObjectId(),
    userId: new mongoose.Types.ObjectId(),
    status: 'Completed',
    prescriptionSigned: true,
    prescriptionTemplate: 'classic',
    prescription: [{ medicine: 'Tab Doxybond LB', dosage: '1 tab', frequency: 'OD', duration: '30 days' }],
  });
  const before = signedContent(note);
  note.prescriptionTemplate = 'minimal';
  // What the signature attests to is unchanged, so saveNote leaves it signed …
  assert.strictEqual(signedContent(note), before);
  // … and the model's pre-save hook does not count it as a clinical edit either.
  assert.ok(ConsultationNote.schema.path('prescriptionTemplate'), 'the field exists on the schema');
  assert.ok(note.isModified('prescriptionTemplate'));
  const clinical = ['complaint', 'examination', 'assessment', 'plan', 'prescription', 'primaryDiagnosis', 'secondaryDiagnosis', 'skinCareAdvice', 'lifestyleAdvice', 'precautions', 'followUpDate', 'doctorName', 'status'];
  assert.ok(!clinical.some((p) => note.isModified(p)));
});
