const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI);
    // Indexes that changed shape after deploy (e.g. the tokens `token` unique
    // index gaining a partial filter once sessions became hashed) are not
    // replaced by autoIndex — the old one stays and every insert with a null
    // token fails with E11000. Bring the session store in line at boot.
    try { await require('../models/Token').syncIndexes(); } catch (indexError) { console.error('⚠️ Token index sync failed:', indexError.message); }

    console.log(`✅ MongoDB Connected Successfully`);
  } catch (error) {
    console.error(`❌ MongoDB Connection Failed:`, error.message);
    process.exit(1);
  }
};

module.exports = connectDB;
