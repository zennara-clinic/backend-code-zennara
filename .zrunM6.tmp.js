require('dotenv').config();
const mongoose = require('mongoose');
(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const AC = require('./models/AppCustomization');
  const d = await AC.findOne({}).lean();
  console.log('AppCustomization docs:', await AC.countDocuments());
  console.log('membership:', JSON.stringify(d?.membership, null, 1));
  console.log('home zenMembershipCardImage:', d?.homeScreen?.zenMembershipCardImage);
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
