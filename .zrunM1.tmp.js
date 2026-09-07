require('dotenv').config();
const mongoose = require('mongoose');
(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const Membership = require('./models/Membership');
  const MA = require('./models/MembershipAssignment');
  const plans = await Membership.find({}).lean();
  console.log('PLANS:', plans.length);
  for (const p of plans) {
    console.log(JSON.stringify({ _id: String(p._id), name: p.name, code: p.code, price: p.price, tax: p.taxPercent, incl: p.priceIncludesTax, validityMonths: p.validityMonths, isActive: p.isActive, isAppDefault: p.isAppDefault, source: p.source, zenotiMembershipId: p.zenotiMembershipId, membersCount: p.membersCount, discounts: p.discounts, credits: (p.credits||[]).length, zenotiRaw: p.zenotiRaw }));
  }
  console.log('\nASSIGNMENTS by membershipId:');
  console.log(JSON.stringify(await MA.aggregate([{ $group: { _id: { m: '$membershipId', s: '$status', src: '$source' }, n: { $sum: 1 } } }]), null, 1));
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
