/**
 * One-off repair: mirrored Zenoti bookings were saved with the placeholder
 * name "Zennara Guest", a blank mobile number and (sometimes) the internal
 * placeholder email, because the history crawl passed a user projection
 * without those fields. The sync now loads them; this backfills existing rows
 * from the owning User. Idempotent and safe to re-run.
 *
 *   node scripts/zenotiRepairBookingIdentity.js [--dry]
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Booking = require('../models/Booking');
const User = require('../models/User');
const { publicEmail, isPlaceholderEmail } = require('../config/zenoti');

const dry = process.argv.includes('--dry');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const filter = {
    source: 'zenoti',
    $or: [
      { fullName: { $in: ['Zennara Guest', '', null] } },
      { mobileNumber: { $in: ['', null] } },
      { email: /@guest\.zennara\.in$|@zennara\.local$/i },
    ],
  };
  const userIds = await Booking.distinct('userId', filter);
  console.log(`Bookings needing repair: ${await Booking.countDocuments(filter)} across ${userIds.length} users${dry ? ' (dry run)' : ''}`);
  const users = await User.find({ _id: { $in: userIds } }).select('fullName phone email').lean();
  const ops = [];
  for (const u of users) {
    const set = {};
    if (u.fullName) set.fullName = u.fullName;
    if (u.phone) set.mobileNumber = u.phone;
    set.email = publicEmail(u.email) || '';
    // Only touch rows that are actually wrong for this user.
    const or = [];
    if (set.fullName) or.push({ fullName: { $in: ['Zennara Guest', '', null] } });
    if (set.mobileNumber) or.push({ mobileNumber: { $in: ['', null] } });
    or.push({ email: /@guest\.zennara\.in$|@zennara\.local$/i });
    if (!isPlaceholderEmail(u.email) && u.email) or.push({ email: { $in: ['', null] } });
    ops.push({ updateMany: { filter: { userId: u._id, source: 'zenoti', $or: or }, update: { $set: set } } });
  }
  if (dry) { console.log(`Would run ${ops.length} updateMany operations.`); }
  else {
    let modified = 0;
    for (let i = 0; i < ops.length; i += 500) {
      const res = await Booking.bulkWrite(ops.slice(i, i + 500), { ordered: false });
      modified += res.modifiedCount || 0;
      process.stdout.write(`\r  ${Math.min(i + 500, ops.length)}/${ops.length} users · ${modified} bookings updated`);
    }
    console.log(`\nDone. Remaining unrepaired: ${await Booking.countDocuments(filter)}`);
  }
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
