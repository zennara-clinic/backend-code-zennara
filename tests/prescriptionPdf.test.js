const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

/*
 * The PDF the guest receives, and the link WhatsApp fetches it through.
 * Pure: no database, no server — the view is built from plain objects the way
 * the sign path hands them over, and the token is checked with a test secret.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-prescription-links';

const { TEMPLATES, buildView } = require('../utils/prescriptionTemplates');
const {
  renderPrescriptionPdf, prescriptionFilename, makeShareToken, verifyShareToken, shareUrl, SHARE_TTL_MS,
} = require('../utils/prescriptionPdf');

const fullNote = (extra = {}) => ({
  prescriptionTemplate: 'classic',
  completedAt: new Date('2026-09-03T10:42:00Z'),
  prescriptionSigned: true,
  prescriptionSignedAt: new Date('2026-09-03T10:42:00Z'),
  prescriptionSignedByName: 'Dr Rickson Pereira',
  prescriptionSignedByRegistration: 'TSMC 45812',
  doctorName: 'Dr Rickson Pereira',
  primaryDiagnosis: 'Acne vulgaris',
  secondaryDiagnosis: 'Post-inflammatory hyperpigmentation',
  complaint: 'Pimples on both cheeks for 3 months',
  examination: 'Papules & pustules, no cysts',
  assessment: 'Moderate inflammatory acne',
  plan: 'Oral + topical, review in 4 weeks',
  prescription: [
    { medicine: 'Doxybond LB', strength: '100 mg', formulation: 'Tab', dosage: '1 tab', frequency: 'OD', duration: '14 days', timing: 'Night', instructions: 'After food', isScheduleH: true },
    { medicine: 'Adapalene', strength: '0.1%', formulation: 'Gel', dosage: 'Pea-sized', frequency: 'HS', duration: '2 months', instructions: 'Thin layer' },
    { medicine: 'Cetaphil Gentle Cleanser', formulation: 'Face wash', dosage: 'Small amount', frequency: 'BD', duration: '2 months' },
  ],
  assignedServices: [{ name: 'Chemical peel', sessions: 3 }],
  skinCareAdvice: 'Sunscreen SPF 50 every morning',
  lifestyleAdvice: 'Sleep 7 hours',
  precautions: 'Avoid picking',
  followUpDate: new Date('2026-10-01'),
  ...extra,
});
const guest = () => ({ fullName: 'Asha Rao', guestCode: 'ZENFD637', dateOfBirth: '12/05/1990', gender: 'Female', drugAllergies: 'Sulpha drugs' });
const booking = () => ({ preferredLocation: 'Jubilee Hills', confirmedDate: new Date('2026-09-03'), consultationId: { name: 'Dermatology consultation' } });
const fullView = (extra) => buildView({ note: fullNote(extra), patient: guest(), booking: booking() });

const isPdf = (buf) => Buffer.isBuffer(buf) && buf.subarray(0, 5).toString() === '%PDF-' && buf.includes('%%EOF');
const pageCount = (buf) => (buf.toString('latin1').match(/\/Type \/Page(?![s])/g) || []).length;

test('the embedded fonts and logos are shipped with the API', () => {
  for (const f of ['Poppins-Regular.ttf', 'Poppins-Medium.ttf', 'Poppins-SemiBold.ttf', 'Poppins-Bold.ttf', 'Poppins-Italic.ttf', 'DancingScript-Regular.ttf']) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'fonts', f)), `public/fonts/${f}`);
  }
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'zennara-logo.png')));
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'zennara-logo-white.png')));
});

for (const template of TEMPLATES) {
  test(`${template}: renders a full signed view, an empty view, and a draft as a PDF`, async () => {
    const signed = await renderPrescriptionPdf(fullView({ prescriptionTemplate: template }));
    const empty = await renderPrescriptionPdf(buildView({}), { template });
    const draft = await renderPrescriptionPdf(fullView({ prescriptionTemplate: template }), { draft: true });
    const unsigned = await renderPrescriptionPdf(fullView({ prescriptionTemplate: template, prescriptionSigned: false, prescriptionSignedByName: null }));
    for (const buf of [signed, empty, draft, unsigned]) {
      assert.ok(isPdf(buf), 'a complete PDF');
      assert.ok(buf.includes('Poppins'), 'Poppins is embedded — the only text face');
      assert.ok(!/Helvetica|Cormorant|Manrope/.test(buf.toString('latin1')), 'no fallback or second typeface');
      assert.ok(buf.includes('/Type /XObject'), 'the logo image is embedded');
    }
    // The script face is embedded only when a signature is drawn.
    assert.ok(signed.includes('DancingScript'), 'signed → the signature face is used');
    assert.ok(!draft.includes('DancingScript'), 'a forced preview draws no signature');
    assert.ok(!unsigned.includes('DancingScript'), 'unsigned → no signature');
    assert.ok(!empty.includes('DancingScript'));
    assert.ok(signed.includes('/Title'), 'document metadata');
  });

  test(`${template}: a long Rx list flows onto further pages, rows intact`, async () => {
    const many = fullNote({
      prescriptionTemplate: template,
      prescription: Array.from({ length: 40 }, (_, i) => ({
        medicine: `Medicine ${i + 1}`, strength: '10 mg', formulation: 'Tab', dosage: '1 tab', frequency: 'BD', duration: '10 days', instructions: 'After food', isScheduleH: i % 3 === 0,
      })),
    });
    const buf = await renderPrescriptionPdf(buildView({ note: many, patient: guest(), booking: booking() }));
    assert.ok(isPdf(buf));
    assert.ok(pageCount(buf) >= 3, `40 lines need several pages, got ${pageCount(buf)}`);
    const one = await renderPrescriptionPdf(fullView({ prescriptionTemplate: template, prescription: [], assignedServices: [], skinCareAdvice: '', lifestyleAdvice: '', precautions: '', complaint: '', examination: '', assessment: '', plan: '' }));
    assert.strictEqual(pageCount(one), 1, 'a short sheet is one page');
  });
}

test('renderPrescriptionPdf defaults to the view template and tolerates an unknown one', async () => {
  const buf = await renderPrescriptionPdf(fullView({ prescriptionTemplate: 'modern' }), { template: 'bogus' });
  assert.ok(isPdf(buf));
  const none = await renderPrescriptionPdf(undefined);
  assert.ok(isPdf(none), 'no view at all still renders the empty sheet');
});

test('the attachment is named for the guest and the clinic date', () => {
  assert.strictEqual(prescriptionFilename(fullView()), 'prescription-asha-rao-2026-09-03.pdf');
  assert.strictEqual(prescriptionFilename(buildView({ note: {}, patient: { fullName: '  Ólafur / Ravi  ' } })), 'prescription-lafur-ravi.pdf');
  assert.strictEqual(prescriptionFilename(null), 'prescription-guest.pdf');
});

/* --- Share links --------------------------------------------------------- */

const NOTE_ID = '66e1a2b3c4d5e6f7a8b9c0d1';

test('a share token round-trips and carries a 7-day expiry', () => {
  const now = Date.parse('2026-09-12T08:00:00Z');
  const { token, expiresAt } = makeShareToken(NOTE_ID, { now });
  assert.match(token, /^[A-Za-z0-9_-]+$/, 'base64url, safe in a URL path');
  assert.strictEqual(expiresAt.getTime(), now + SHARE_TTL_MS);
  assert.strictEqual(SHARE_TTL_MS, 7 * 24 * 60 * 60 * 1000);
  const claim = verifyShareToken(token, { now: now + 1000 });
  assert.deepStrictEqual(claim, { noteId: NOTE_ID, expiresAt });
  // The raw form is <noteId>.<exp>.<hmac-sha256 hex>
  const raw = Buffer.from(token, 'base64url').toString('utf8').split('.');
  assert.strictEqual(raw.length, 3);
  assert.strictEqual(raw[0], NOTE_ID);
  assert.strictEqual(Number(raw[1]), expiresAt.getTime());
  assert.match(raw[2], /^[a-f0-9]{64}$/);
});

test('an expired, tampered, foreign or malformed token is rejected', () => {
  const now = Date.parse('2026-09-12T08:00:00Z');
  const { token } = makeShareToken(NOTE_ID, { now });
  assert.strictEqual(verifyShareToken(token, { now: now + SHARE_TTL_MS + 1 }), null, 'expired');
  assert.strictEqual(verifyShareToken(token, { now: now + SHARE_TTL_MS }), null, 'expiry is exclusive');

  const [id, exp, mac] = Buffer.from(token, 'base64url').toString('utf8').split('.');
  const forge = (parts) => Buffer.from(parts.join('.'), 'utf8').toString('base64url');
  assert.strictEqual(verifyShareToken(forge(['66e1a2b3c4d5e6f7a8b9c0d2', exp, mac]), { now }), null, 'another note id');
  assert.strictEqual(verifyShareToken(forge([id, String(Number(exp) + 86400000), mac]), { now }), null, 'a longer expiry');
  assert.strictEqual(verifyShareToken(forge([id, exp, mac.replace(/^./, (c) => (c === 'a' ? 'b' : 'a'))]), { now }), null, 'a flipped mac');
  assert.strictEqual(verifyShareToken(forge([id, exp, mac.slice(0, 63)]), { now }), null, 'a short mac');
  assert.strictEqual(verifyShareToken(forge([id, exp]), { now }), null, 'missing part');
  assert.strictEqual(verifyShareToken(forge([id, exp, mac, 'x']), { now }), null, 'extra part');
  assert.strictEqual(verifyShareToken('', { now }), null);
  assert.strictEqual(verifyShareToken(null, { now }), null);
  assert.strictEqual(verifyShareToken('not base64url at all!!', { now }), null);
  assert.strictEqual(verifyShareToken('x'.repeat(600), { now }), null, 'oversized');

  // A token minted under another secret is worthless here.
  const secret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'someone-elses-secret';
  const foreign = makeShareToken(NOTE_ID, { now }).token;
  process.env.JWT_SECRET = secret;
  assert.strictEqual(verifyShareToken(foreign, { now }), null, 'foreign secret');
  assert.ok(verifyShareToken(token, { now }), 'the real one still verifies');
});

test('minting needs a secret and a real note id', () => {
  assert.throws(() => makeShareToken('nope'), /note id/);
  const secret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = '';
  assert.throws(() => makeShareToken(NOTE_ID), /JWT_SECRET/);
  assert.strictEqual(verifyShareToken('anything'), null, 'nothing verifies without a secret');
  process.env.JWT_SECRET = secret;
});

test('the share URL lives under the public API origin, or is absent without one', () => {
  const prev = process.env.API_PUBLIC_URL;
  process.env.API_PUBLIC_URL = 'https://api.zennara.in/';
  assert.strictEqual(shareUrl('abc'), 'https://api.zennara.in/api/prescriptions/shared/abc.pdf');
  process.env.API_PUBLIC_URL = '';
  assert.strictEqual(shareUrl('abc'), null);
  if (prev === undefined) delete process.env.API_PUBLIC_URL; else process.env.API_PUBLIC_URL = prev;
});

/* --- Delivery on signature ---------------------------------------------- */

test('the sign response says exactly what was delivered', () => {
  const { deliveryMessage, needsDelivery } = require('../controllers/consultationNoteController');
  const ok = (to) => ({ ok: true, to, at: new Date(), error: null });
  const failed = (to) => ({ ok: false, to, at: new Date(), error: 'boom' });
  const none = () => ({ ok: false, to: null, at: new Date(), error: 'No address on file' });
  const msg = (whatsapp, email) => deliveryMessage({ at: new Date(), pdfBytes: 1, whatsapp, email });

  assert.strictEqual(msg(ok('91'), ok('a@b.c')), 'Signed — sent by WhatsApp and email');
  assert.strictEqual(msg(ok('91'), none()), 'Signed — WhatsApp sent; no email on file');
  assert.strictEqual(msg(ok('91'), failed('a@b.c')), 'Signed — WhatsApp sent; email failed');
  assert.strictEqual(msg(none(), ok('a@b.c')), 'Signed — email sent; no phone on file');
  assert.strictEqual(msg(failed('91'), ok('a@b.c')), 'Signed — email sent; WhatsApp failed');
  assert.strictEqual(msg(none(), none()), 'Signed — no phone or email on file; nothing sent');
  assert.strictEqual(msg(failed('91'), failed('a@b.c')), 'Signed — WhatsApp and email failed');
  assert.strictEqual(msg(failed('91'), none()), 'Signed — WhatsApp failed; no email on file');
  assert.strictEqual(msg(none(), failed('a@b.c')), 'Signed — email failed; no phone on file');

  // Delivery happens once per signature, and again only for a channel that had an address and failed.
  assert.strictEqual(needsDelivery(null), true);
  assert.strictEqual(needsDelivery({ at: new Date(), whatsapp: ok('91'), email: ok('a@b.c') }), false);
  assert.strictEqual(needsDelivery({ at: new Date(), whatsapp: ok('91'), email: none() }), false, 'no address → nothing to retry');
  assert.strictEqual(needsDelivery({ at: new Date(), whatsapp: failed('91'), email: ok('a@b.c') }), true, 'a failed send is retried');
});

test('there is no manual send route; the PDF routes and the public shared link are wired', () => {
  const notes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'consultationNote.js'), 'utf8');
  assert.ok(!/['"]\/:id\/send['"]/.test(notes), 'POST /consultation-notes/:id/send is gone');
  assert.ok(notes.includes("'/:id/prescription.pdf'"), 'the staff PDF route');
  assert.ok(notes.includes("'/:id/prescription.html'"), 'the HTML fallback stays');
  const ctrl = require('../controllers/consultationNoteController');
  assert.strictEqual(ctrl.sendPrescription, undefined, 'no sendPrescription handler');
  assert.strictEqual(typeof ctrl.renderPrescriptionPdf, 'function');

  const rx = fs.readFileSync(path.join(__dirname, '..', 'routes', 'prescriptions.js'), 'utf8');
  const shared = rx.indexOf("'/shared/:token.pdf'");
  const guard = rx.indexOf('router.use(protect)');
  assert.ok(shared > -1 && guard > -1 && shared < guard, 'the shared PDF route is mounted before protect');
  assert.ok(/sharedPdfLimiter/.test(rx.slice(shared, shared + 80)), 'and rate-limited');
  assert.ok(rx.includes("'/:id/pdf'") && rx.includes("'/:id/share-link'") && rx.includes("'/:id/html'"));
});
