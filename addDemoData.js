const dotenv = require('dotenv');
dotenv.config();

const mongoose = require('mongoose');
const Booking = require('./models/Booking');
const User = require('./models/User');
const Branch = require('./models/Branch');
const Consultation = require('./models/Consultation');

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ MongoDB Connected');
  } catch (error) {
    console.error('❌ MongoDB Connection Failed:', error.message);
    process.exit(1);
  }
};

const generateFutureDate = (daysFromNow) => {
  const date = new Date();
  date.setDate(date.getDate() + daysFromNow);
  date.setHours(0, 0, 0, 0);
  return date;
};

const addDemoData = async () => {
  try {
    await connectDB();

    // Find DEMO user (phone: 9999999999)
    const demoUser = await User.findOne({ phone: '9999999999' });
    if (!demoUser) {
      console.error('❌ Demo user not found with phone: 9999999999');
      console.log('💡 Run: node createDemoAccount.js first');
      process.exit(1);
    }
    console.log(`✅ Found demo user: ${demoUser.fullName} (${demoUser.phone})`);

    // Get consultations and branches
    const consultations = await Consultation.find({ isActive: true }).limit(5);
    const branches = await Branch.find({ isActive: true }).limit(3);

    if (consultations.length === 0 || branches.length === 0) {
      console.error('❌ No consultations or branches found');
      process.exit(1);
    }

    // Check if demo user already has bookings
    const existingBookings = await Booking.find({ userId: demoUser._id });
    if (existingBookings.length > 0) {
      console.log(`ℹ️  Demo user already has ${existingBookings.length} bookings`);
      console.log('✅ Demo data already exists');
      process.exit(0);
    }

    // Create 3 sample bookings
    const bookingData = [
      {
        daysFromNow: 5,
        timeSlots: ['10:00 AM', '11:00 AM'],
        status: 'Awaiting Confirmation'
      },
      {
        daysFromNow: 10,
        timeSlots: ['2:00 PM'],
        status: 'Awaiting Confirmation'
      },
      {
        daysFromNow: -3, // Past appointment
        timeSlots: ['3:00 PM'],
        status: 'Completed'
      }
    ];

    for (let i = 0; i < bookingData.length; i++) {
      const data = bookingData[i];
      const consultation = consultations[i % consultations.length];
      const branch = branches[i % branches.length];

      const booking = await Booking.create({
        userId: demoUser._id,
        consultationId: consultation._id,
        fullName: demoUser.fullName,
        mobileNumber: demoUser.phone,
        email: demoUser.email,
        branchId: branch._id,
        preferredLocation: branch.name,
        preferredDate: generateFutureDate(data.daysFromNow),
        preferredTimeSlots: data.timeSlots,
        status: data.status,
        amount: consultation.price || 0,
        notes: 'Sample booking for Apple Review'
      });

      console.log(`✅ Booking ${i + 1}: ${booking.referenceNumber} - ${data.status}`);
    }

    console.log('\n✅ Demo data added successfully!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📱 Login Phone: 9999999999');
    console.log('🔐 OTP: 1234 (fixed)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    await mongoose.connection.close();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
};

addDemoData();
