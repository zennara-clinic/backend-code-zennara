/**
 * Script to create demo account for Apple Store review
 * Run this once: node createDemoAccount.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/User');

const DEMO_ACCOUNT = {
  email: 'demo@zennara.com',
  fullName: 'Demo User',
  phone: '9999999999',  // 10 digits only
  location: 'Jubilee Hills',  // Valid enum value
  dateOfBirth: '1990-01-01',
  gender: 'Other',
  memberType: 'Regular Member',  // Valid enum value
  isVerified: true,
  emailVerified: true,
  privacyPolicyAccepted: true,
  termsAccepted: true
};

async function createDemoAccount() {
  try {
    // Connect to database
    await mongoose.connect(process.env.MONGODB_URI);

    console.log('✅ Connected to MongoDB');

    // Check if demo account already exists
    const existingDemo = await User.findOne({ email: DEMO_ACCOUNT.email });

    if (existingDemo) {
      console.log('ℹ️  Demo account already exists');
      console.log('👤 Name:', existingDemo.fullName);
      console.log('📱 Phone:', existingDemo.phone);
      console.log('📧 Email:', existingDemo.email);
      console.log('📍 Location:', existingDemo.location);
      console.log('\n✅ Demo account is ready for Apple Store review');
      console.log('   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('   📱 Login Phone: 9999999999');
      console.log('   🔐 Demo OTP: 1234 (fixed)');
      console.log('   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('\n   Instructions for Apple Review:');
      console.log('   1. Enter phone number: 9999999999');
      console.log('   2. Enter OTP: 1234');
      console.log('   3. Access all features without restrictions');
    } else {
      // Create demo account
      const demoUser = await User.create(DEMO_ACCOUNT);

      console.log('✅ Demo account created successfully!');
      console.log('👤 Name:', demoUser.fullName);
      console.log('📱 Phone:', demoUser.phone);
      console.log('📧 Email:', demoUser.email);
      console.log('📍 Location:', demoUser.location);
      console.log('\n✅ Demo account is ready for Apple Store review');
      console.log('   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('   📱 Login Phone: 9999999999');
      console.log('   🔐 Demo OTP: 1234 (fixed)');
      console.log('   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('\n   Instructions for Apple Review:');
      console.log('   1. Enter phone number: 9999999999');
      console.log('   2. Enter OTP: 1234');
      console.log('   3. Access all features without restrictions');
    }

    process.exit(0);
  } catch (error) {
    console.error('❌ Error creating demo account:', error.message);
    process.exit(1);
  }
}

createDemoAccount();
