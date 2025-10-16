const mongoose = require('mongoose');
const Consultation = require('../models/Consultation');
require('dotenv').config();

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/zennara', {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('✅ MongoDB Connected'))
.catch(err => console.error('❌ MongoDB Connection Error:', err));

async function checkConsultation() {
  try {
    // Check the "Art Lip Filler 1ml" consultation
    const consultation = await Consultation.findOne({ 
      slug: 'art-lip-filler-1ml' 
    });

    if (!consultation) {
      console.log('❌ Consultation not found!');
      return;
    }

    console.log('\n📋 Consultation Details:\n');
    console.log('Name:', consultation.name);
    console.log('ID:', consultation.id);
    console.log('Slug:', consultation.slug);
    console.log('\n📷 Image & Media:\n');
    console.log('Primary Image:', consultation.image || '❌ MISSING');
    console.log('Has media field:', consultation.media !== undefined);
    console.log('Media array:', consultation.media || '❌ MISSING');
    
    if (consultation.media && Array.isArray(consultation.media)) {
      console.log('Media count:', consultation.media.length);
      if (consultation.media.length > 0) {
        console.log('\n📸 Media Items:');
        consultation.media.forEach((item, index) => {
          console.log(`\n  ${index + 1}. Type: ${item.type}`);
          console.log(`     URL: ${item.url}`);
          console.log(`     Thumbnail: ${item.thumbnail || 'N/A'}`);
          console.log(`     Public ID: ${item.publicId || 'N/A'}`);
        });
      } else {
        console.log('\n⚠️  Media array is EMPTY');
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log('\n🔍 What this means:\n');
    
    if (!consultation.media) {
      console.log('❌ The consultation does NOT have a media field.');
      console.log('   Run: node scripts/addMediaFieldToExisting.js\n');
    } else if (consultation.media.length === 0) {
      console.log('⚠️  The consultation has an empty media array.');
      console.log('   Go to admin panel and upload images.\n');
    } else {
      console.log('✅ The consultation has media!');
      console.log('   If not showing in mobile app, check:');
      console.log('   1. Are the URLs accessible in a browser?');
      console.log('   2. Is the mobile app using cached data?');
      console.log('   3. Check mobile app console logs.\n');
    }

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB\n');
  }
}

// Run the script
checkConsultation();
