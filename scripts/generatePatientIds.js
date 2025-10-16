/**
 * Migration script to generate 8-character patient IDs for existing users
 * Run this once to update all existing users with the new patientId field
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

const generatePatientIds = async () => {
  try {
    console.log('🔗 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    // Find all users without a patientId
    const users = await User.find({ $or: [{ patientId: null }, { patientId: { $exists: false } }] });
    console.log(`📊 Found ${users.length} users without patient IDs`);

    if (users.length === 0) {
      console.log('✅ All users already have patient IDs');
      process.exit(0);
    }

    let updated = 0;
    let failed = 0;

    for (const user of users) {
      try {
        // The pre-save hook will automatically generate the patientId
        await user.save();
        updated++;
        console.log(`✅ Generated patient ID for ${user.fullName}: ${user.patientId}`);
      } catch (error) {
        failed++;
        console.error(`❌ Failed to generate patient ID for ${user.fullName}:`, error.message);
      }
    }

    console.log('\n📊 Migration Summary:');
    console.log(`   ✅ Successfully updated: ${updated}`);
    console.log(`   ❌ Failed: ${failed}`);
    console.log(`   📝 Total processed: ${users.length}`);

    process.exit(0);
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
};

// Run the migration
generatePatientIds();
