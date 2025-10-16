const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Consultation = require('../models/Consultation');
const consultationsData = require('../data/consultations.json');

// Load environment variables
dotenv.config();

// Connect to MongoDB
const connectDB = async () => {
  try {
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    await mongoose.connect(mongoUri);
    console.log('✅ MongoDB connected for seeding');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

// Seed consultations
const seedConsultations = async () => {
  try {
    await connectDB();

    console.log('🗑️  Clearing existing consultations...');
    await Consultation.deleteMany({});

    console.log('📦 Seeding consultations...');
    const consultations = await Consultation.insertMany(consultationsData);

    console.log(`✅ ${consultations.length} consultations seeded successfully!`);
    console.log('\n📋 Seeded consultations:');
    consultations.forEach((consultation, index) => {
      console.log(`   ${index + 1}. ${consultation.name} - ${consultation.category} - ₹${consultation.price}`);
    });

    process.exit(0);
  } catch (error) {
    console.error('❌ Seeding error:', error);
    process.exit(1);
  }
};

// Run seeding
seedConsultations();
