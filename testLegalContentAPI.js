require('dotenv').config();
const mongoose = require('mongoose');
const AppCustomization = require('./models/AppCustomization');

const testLegalContentAPI = async () => {
  try {
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB\n');

    console.log('📡 Simulating API call: GET /api/app-customization');
    console.log('─────────────────────────────────────────────\n');

    const settings = await AppCustomization.findOne({ isActive: true });
    
    if (!settings) {
      console.log('❌ No settings found!');
      process.exit(1);
    }

    console.log('📊 Database Record Found:');
    console.log('─────────────────────────────────────────────');
    console.log(`_id: ${settings._id}`);
    console.log(`isActive: ${settings.isActive}`);
    console.log(`version: ${settings.version}`);
    console.log(`lastUpdatedAt: ${settings.lastUpdatedAt}`);
    console.log('─────────────────────────────────────────────\n');

    console.log('📝 Terms of Service:');
    console.log('─────────────────────────────────────────────');
    console.log(`Length: ${settings.termsOfService?.length || 0} characters`);
    console.log(`Has content: ${!!settings.termsOfService}`);
    console.log(`First 200 chars:\n${settings.termsOfService?.substring(0, 200)}...`);
    console.log('─────────────────────────────────────────────\n');

    console.log('🔒 Privacy Policy:');
    console.log('─────────────────────────────────────────────');
    console.log(`Length: ${settings.privacyPolicy?.length || 0} characters`);
    console.log(`Has content: ${!!settings.privacyPolicy}`);
    console.log(`First 200 chars:\n${settings.privacyPolicy?.substring(0, 200)}...`);
    console.log('─────────────────────────────────────────────\n');

    // Simulate the API response
    const apiResponse = {
      success: true,
      data: settings,
      version: settings.version
    };

    console.log('✅ API Response Structure:');
    console.log('─────────────────────────────────────────────');
    console.log(`success: ${apiResponse.success}`);
    console.log(`data exists: ${!!apiResponse.data}`);
    console.log(`data.termsOfService exists: ${!!apiResponse.data.termsOfService}`);
    console.log(`data.termsOfService length: ${apiResponse.data.termsOfService?.length || 0}`);
    console.log(`data.privacyPolicy exists: ${!!apiResponse.data.privacyPolicy}`);
    console.log(`data.privacyPolicy length: ${apiResponse.data.privacyPolicy?.length || 0}`);
    console.log(`version: ${apiResponse.version}`);
    console.log('─────────────────────────────────────────────\n');

    console.log('✅ Test Complete - API should return legal content properly');
    
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error testing API:', error);
    process.exit(1);
  }
};

testLegalContentAPI();
