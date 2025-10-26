require('dotenv').config();
const mongoose = require('mongoose');
const Booking = require('../models/Booking');

const clearAllBookings = async () => {
  try {
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    console.log('🗑️  Clearing all bookings...');
    const result = await Booking.deleteMany({});
    
    console.log(`✅ Successfully deleted ${result.deletedCount} bookings`);
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error clearing bookings:', error);
    process.exit(1);
  }
};

clearAllBookings();
