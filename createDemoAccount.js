/**
 * Script to create demo account for Google Play review
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
      console.log('📧 Email:', existingDemo.email);
      console.log('👤 Name:', existingDemo.fullName);
      console.log('📱 Phone:', existingDemo.phone);
      console.log('\n✅ Demo account is ready for Google Play review');
      console.log('   Login with: demo@zennara.com');
      console.log('   OTP: 1234 (fixed for demo account)');
    } else {
      // Create demo account
      const demoUser = await User.create(DEMO_ACCOUNT);

      console.log('✅ Demo account created successfully!');
      console.log('📧 Email:', demoUser.email);
      console.log('👤 Name:', demoUser.fullName);
      console.log('📱 Phone:', demoUser.phone);
      console.log('📍 Location:', demoUser.location);
      console.log('\n✅ Demo account is ready for Google Play review');
      console.log('   Login with: demo@zennara.com');
      console.log('   OTP: 1234 (fixed for demo account)');
    }

    process.exit(0);
  } catch (error) {
    console.error('❌ Error creating demo account:', error.message);
    process.exit(1);
  }
}

createDemoAccount();
