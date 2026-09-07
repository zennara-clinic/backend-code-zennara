require('dotenv').config();
const mongoose = require('mongoose');
(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const ZGD = require('./models/ZenotiGuestData');
  const User = require('./models/User');
  console.log('ZenotiGuestData docs:', await ZGD.countDocuments());
  console.log('docs with >=1 membership:', await ZGD.countDocuments({ 'memberships.0': { $exists: true } }));
  const agg = await ZGD.aggregate([
    { $unwind: '$memberships' },
    { $group: { _id: { name: '$memberships.name', id: '$memberships.id' }, n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ]);
  console.log('MEMBERSHIP ROWS ACROSS GUESTS:');
  agg.forEach(a => console.log(' ', a.n, '|', JSON.stringify(a._id)));
  const sample = await ZGD.findOne({ 'memberships.0': { $exists: true } }).lean();
  console.log('\nSAMPLE membership object:', JSON.stringify(sample?.memberships?.[0], null, 1));
  console.log('\nUser.memberType distribution:', JSON.stringify(await User.aggregate([{ $group: { _id: '$memberType', n: { $sum: 1 } } }])));
  console.log('users total:', await User.countDocuments());
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
