const mongoose = require('mongoose');
require('dotenv').config();
const Consultation = require('../models/Consultation');

// MongoDB Connection
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ MongoDB Connected Successfully');
  } catch (error) {
    console.error('❌ MongoDB Connection Error:', error.message);
    process.exit(1);
  }
};

// Update all consultation ratings to null
const updateRatings = async () => {
  try {
    console.log('🔄 Starting to update consultation ratings...');

    // Update all consultations to set rating to null
    const result = await Consultation.updateMany(
      {}, // Match all consultations
      { $set: { rating: null } } // Set rating to null
    );

    console.log(`✅ Updated ${result.modifiedCount} consultations`);
    console.log(`📊 Total consultations matched: ${result.matchedCount}`);
    
    // Show sample of updated consultations
    const updatedConsultations = await Consultation.find({}).select('name rating').limit(5);
    console.log('\n📋 Sample of updated consultations:');
    updatedConsultations.forEach(consultation => {
      console.log(`   - ${consultation.name}: rating = ${consultation.rating}`);
    });

    console.log('\n✨ All consultation ratings have been set to null (unrated)');
    console.log('💡 Ratings will only show when users rate after completing appointments\n');

  } catch (error) {
    console.error('❌ Error updating ratings:', error);
    throw error;
  }
};

// Main execution
const main = async () => {
  try {
    await connectDB();
    await updateRatings();
    console.log('✅ Script completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('❌ Script failed:', error);
    process.exit(1);
  }
};

// Run the script
main();
