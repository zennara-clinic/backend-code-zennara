/**
 * One-off: attribute existing Zenoti-synced bookings to a dermatologist and
 * recover their invoiced amount from the per-guest history mirror.
 *   node scripts/backfillZenotiBookingAttribution.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const Booking = require('../models/Booking');
  const Doctor = require('../models/Doctor');
  const ZenotiGuestData = require('../models/ZenotiGuestData');
  const { buildDoctorMatcher, tierTitle } = require('../utils/dermatologistMatch');

  const match = buildDoctorMatcher(await Doctor.find({}).select('doctorId name tier').lean());
  const bookings = await Booking.find({ source: 'zenoti' }).select('zenotiAppointmentId therapistName specialistId amount status paymentStatus confirmedDate checkOutTime userId').lean();
  const byUser = new Map();
  for (const b of bookings) byUser.set(String(b.userId), [...(byUser.get(String(b.userId)) || []), b]);

  await Booking.updateMany({ source: 'zenoti', slotHeld: true }, { $set: { slotHeld: false } });
  let derm = 0, amt = 0, paid = 0;
  for (const [userId, list] of byUser) {
    const mirror = await ZenotiGuestData.findOne({ userId }).select('appointments').lean();
    const priceById = new Map((mirror?.appointments || []).map((a) => [String(a.id || '').toLowerCase(), { price: a.price, therapist: a.therapistName }]));
    for (const b of list) {
      const set = {};
      const hist = priceById.get(String(b.zenotiAppointmentId || '').toLowerCase());
      const name = b.therapistName || hist?.therapist;
      const d = match(name);
      if (d && !b.specialistId) { set.specialistId = d.doctorId; set.specialistName = d.name; set.specialistTier = tierTitle(d); derm += 1; }
      const price = Number(hist?.price);
      if ((!b.amount || b.amount === 0) && Number.isFinite(price) && price > 0) { set.amount = price; amt += 1; }
      const finalAmount = set.amount ?? b.amount ?? 0;
      if (b.status === 'Completed' && finalAmount > 0 && b.paymentStatus !== 'paid') { set.paymentStatus = 'paid'; set.paidAt = b.checkOutTime || b.confirmedDate || new Date(); set.paymentMethod = 'Other'; paid += 1; }
      if (Object.keys(set).length) await Booking.updateOne({ _id: b._id }, { $set: set });
    }
  }
  console.log({ bookings: bookings.length, dermatologistAttributed: derm, amountRecovered: amt, markedPaid: paid });
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
