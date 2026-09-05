/**
 * The guest's own prescriptions — read-only.
 *
 * A prescription is the completed consultation note the dermatologist wrote
 * in the panel. The guest sees the structured lines (medicine, strength, dose,
 * frequency, duration, timing, instructions), the linked pharmacy product when
 * there is one (so a line can go straight into the cart), the diagnosis and
 * advice, the follow-up date and when a refill falls due.
 */
const ConsultationNote = require('../models/ConsultationNote');
const { getGuestEligibility } = require('../utils/guestEligibility');

/** "14 days", "2 weeks", "1 month", "10 days x 2" → days; null when unparseable. */
function daysFromDuration(text) {
  const m = String(text || '').match(/(\d+(?:\.\d+)?)\s*(day|week|month|wk|mo)/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  if (unit.startsWith('w')) return Math.round(n * 7);
  if (unit.startsWith('m')) return Math.round(n * 30);
  return Math.round(n);
}
exports.daysFromDuration = daysFromDuration;

function refillDueAt(note, item) {
  const days = Number(item.refillAfterDays) > 0 ? Number(item.refillAfterDays) : daysFromDuration(item.duration);
  if (!days) return null;
  const from = note.completedAt || note.createdAt;
  return from ? new Date(new Date(from).getTime() + days * 86400000) : null;
}
exports.refillDueAt = refillDueAt;

const PRODUCT_FIELDS = '_id name description formulation OrgName price gstPercentage image stock trackStock isActive isPopular sku';

function shape(note) {
  const booking = note.bookingId && typeof note.bookingId === 'object' ? note.bookingId : null;
  const service = booking?.consultationId && typeof booking.consultationId === 'object' ? booking.consultationId : null;
  return {
    _id: note._id,
    date: note.completedAt || note.createdAt,
    doctorName: note.doctorName || null,
    doctorId: note.doctorId || null,
    signed: Boolean(note.prescriptionSigned),
    signedBy: note.prescriptionSignedByName || null,
    centre: booking?.preferredLocation || null,
    service: service?.name || booking?.externalServiceName || null,
    visitDate: booking?.confirmedDate || booking?.preferredDate || null,
    bookingId: booking?._id || note.bookingId || null,
    diagnosis: { primary: note.primaryDiagnosis || '', secondary: note.secondaryDiagnosis || '' },
    advice: { skinCare: note.skinCareAdvice || '', lifestyle: note.lifestyleAdvice || '', precautions: note.precautions || '' },
    followUpDate: note.followUpDate || null,
    items: (note.prescription || []).map((item, index) => {
      const product = item.productId && typeof item.productId === 'object' ? item.productId : null;
      const available = product ? product.isActive !== false && (product.trackStock === false || (product.stock ?? 0) > 0) : false;
      return {
        index,
        medicine: item.medicine,
        strength: item.strength || null,
        formulation: item.formulation || null,
        dosage: item.dosage || null,
        frequency: item.frequency || null,
        duration: item.duration || null,
        timing: item.timing || null,
        instructions: item.instructions || null,
        isScheduleH: Boolean(item.isScheduleH),
        refillAfterDays: Number(item.refillAfterDays) > 0 ? Number(item.refillAfterDays) : daysFromDuration(item.duration),
        refillDueAt: refillDueAt(note, item),
        sku: product?.sku || null,
        product: product ? { ...product, available } : null,
        productId: product ? product._id : item.productId || null,
      };
    }),
    assignedServices: (note.assignedServices || []).map((s) => ({
      serviceId: s.serviceId || null, packageId: s.packageId || null, name: s.name, sessions: s.sessions || 1,
    })),
  };
}

const populate = (q) => q
  .populate({ path: 'bookingId', select: 'preferredLocation preferredDate confirmedDate externalServiceName consultationId', populate: { path: 'consultationId', select: 'name category' } })
  .populate('prescription.productId', PRODUCT_FIELDS);

// GET /api/prescriptions — the signed-in guest's completed prescriptions, newest first.
exports.listMine = async (req, res) => {
  try {
    const notes = await populate(ConsultationNote.find({ userId: req.user._id, status: 'Completed' }).sort({ completedAt: -1, createdAt: -1 })).lean();
    return res.json({ success: true, data: notes.map(shape) });
  } catch (error) {
    console.error('List prescriptions failed:', error);
    return res.status(500).json({ success: false, message: 'Could not load your prescriptions right now.' });
  }
};

// GET /api/prescriptions/:id
exports.getMine = async (req, res) => {
  try {
    const note = await populate(ConsultationNote.findOne({ _id: req.params.id, userId: req.user._id, status: 'Completed' })).lean();
    if (!note) return res.status(404).json({ success: false, message: 'This prescription is not available.' });
    return res.json({ success: true, data: shape(note) });
  } catch (error) {
    console.error('Get prescription failed:', error);
    return res.status(500).json({ success: false, message: 'Could not load this prescription right now.' });
  }
};

// GET /api/bookings/eligibility — what the guest may book today.
exports.eligibility = async (req, res) => {
  try {
    return res.json({ success: true, data: await getGuestEligibility(req.user._id) });
  } catch (error) {
    console.error('Eligibility failed:', error);
    return res.status(500).json({ success: false, message: 'Could not check your booking options right now.' });
  }
};
