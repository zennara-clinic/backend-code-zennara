const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Vendor = require('../models/Vendor');
const vendorsData = require('../data/vendors.json');

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

// Seed vendors
const seedVendors = async () => {
  try {
    await connectDB();

    console.log('🗑️  Clearing existing vendors...');
    await Vendor.deleteMany({});

    console.log('📦 Seeding vendors...');
    const vendors = await Vendor.insertMany(vendorsData);

    console.log(`✅ ${vendors.length} vendors seeded successfully!`);
    console.log('\n📋 Seeded vendors:');
    vendors.forEach((vendor, index) => {
      console.log(`   ${index + 1}. ${vendor.name} - ${vendor.city}, ${vendor.state} - ${vendor.status} - Rating: ${vendor.rating}⭐`);
    });

    console.log('\n📊 Summary:');
    const activeVendors = vendors.filter(v => v.status === 'Active').length;
    const inactiveVendors = vendors.filter(v => v.status === 'Inactive').length;
    console.log(`   Active: ${activeVendors}`);
    console.log(`   Inactive: ${inactiveVendors}`);

    process.exit(0);
  } catch (error) {
    console.error('❌ Seeding error:', error);
    process.exit(1);
  }
};

// Run seeding
seedVendors();
