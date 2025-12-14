require('dotenv').config();
const mongoose = require('mongoose');
const AppCustomization = require('./models/AppCustomization');

const updateLegalContent = async () => {
  try {
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    console.log('📝 Fetching or creating AppCustomization settings...');
    let settings = await AppCustomization.findOne({ isActive: true });
    
    if (!settings) {
      console.log('📄 No existing settings found, creating new document...');
      settings = new AppCustomization();
      await settings.save();
      console.log('✅ Created new AppCustomization document with default legal content');
    } else {
      console.log('📄 Found existing settings, checking legal content...');
      
      // Check if legal content needs updating
      const needsUpdate = !settings.termsOfService || !settings.privacyPolicy || 
                          settings.termsOfService.length < 1000 || 
                          settings.privacyPolicy.length < 1000;
      
      if (needsUpdate) {
        console.log('🔄 Updating legal content with comprehensive versions...');
        
        // Get default values from schema
        const defaultSettings = new AppCustomization();
        settings.termsOfService = defaultSettings.termsOfService;
        settings.privacyPolicy = defaultSettings.privacyPolicy;
        settings.version += 1;
        settings.lastUpdatedAt = new Date();
        
        await settings.save();
        console.log('✅ Legal content updated successfully');
      } else {
        console.log('✓ Legal content already populated');
      }
    }

    console.log('\n📊 Current Legal Content Status:');
    console.log('─────────────────────────────────────────────');
    console.log(`Terms of Service: ${settings.termsOfService?.length || 0} characters`);
    console.log(`Privacy Policy: ${settings.privacyPolicy?.length || 0} characters`);
    console.log(`Version: ${settings.version}`);
    console.log(`Last Updated: ${settings.lastUpdatedAt}`);
    console.log('─────────────────────────────────────────────');
    
    console.log('\n✅ All done! The mobile app will now fetch this content from the backend.');
    console.log('📱 Frontend screens are already configured to display this content.');
    
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error updating legal content:', error);
    process.exit(1);
  }
};

updateLegalContent();
