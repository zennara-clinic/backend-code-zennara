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

async function addMediaFieldToExistingConsultations() {
  try {
    console.log('🔄 Adding media field to existing consultations...\n');

    // Find all consultations that don't have the media field
    const consultations = await Consultation.find({});

    console.log(`Found ${consultations.length} consultations\n`);

    let updated = 0;
    let alreadyHadMedia = 0;

    for (const consultation of consultations) {
      // Check if media field exists
      if (!consultation.media || !Array.isArray(consultation.media)) {
        // Add empty media array
        consultation.media = [];
        await consultation.save();
        updated++;
        console.log(`✅ Updated: ${consultation.name} (${consultation.id})`);
        console.log(`   - Added empty media array\n`);
      } else {
        alreadyHadMedia++;
        console.log(`ℹ️  Already has media: ${consultation.name} (${consultation.id})`);
        console.log(`   - Media count: ${consultation.media.length}\n`);
      }
    }

    console.log('\n📊 Summary:');
    console.log(`   Total consultations: ${consultations.length}`);
    console.log(`   Updated with media field: ${updated}`);
    console.log(`   Already had media field: ${alreadyHadMedia}`);
    console.log('\n✅ Done! All consultations now have the media field.');
    console.log('👉 Now go to the admin panel and upload images to the consultations.\n');

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
  }
}

// Run the script
addMediaFieldToExistingConsultations();
