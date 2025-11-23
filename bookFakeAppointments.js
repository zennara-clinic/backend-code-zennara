const dotenv = require('dotenv');
dotenv.config();

const mongoose = require('mongoose');
const Booking = require('./models/Booking');
const Consultation = require('./models/Consultation');
const User = require('./models/User');
const Branch = require('./models/Branch');

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

const generateTimeSlots = () => {
  const slots = [];
  const times = ['10:00 AM', '11:00 AM', '12:00 PM', '2:00 PM', '3:00 PM', '4:00 PM', '5:00 PM'];
  const randomCount = Math.floor(Math.random() * 2) + 1; // 1-2 slots
  
  for (let i = 0; i < randomCount; i++) {
    const randomIndex = Math.floor(Math.random() * times.length);
    slots.push(times[randomIndex]);
  }
  
  return [...new Set(slots)]; // Remove duplicates
};

const bookFakeAppointments = async () => {
  try {
    await connectDB();

    // Find user by email
    const user = await User.findOne({ email: 'thekhushnoor@gmail.com' });
    if (!user) {
      console.error('❌ User not found with email: thekhushnoor@gmail.com');
      process.exit(1);
    }
    console.log(`✅ Found user: ${user.fullName} (${user.email})`);

    // Get all active consultations
    const consultations = await Consultation.find({ isActive: true }).limit(10);
    if (consultations.length === 0) {
      console.error('❌ No active consultations found');
      process.exit(1);
    }
    console.log(`✅ Found ${consultations.length} active consultations`);

    // Get all active branches
    const branches = await Branch.find({ isActive: true });
    if (branches.length === 0) {
      console.error('❌ No active branches found');
      process.exit(1);
    }
    console.log(`✅ Found ${branches.length} active branches`);

    // Book 5 fake appointments
    const bookingCount = 5;
    const bookings = [];

    for (let i = 0; i < bookingCount; i++) {
      const randomConsultation = consultations[Math.floor(Math.random() * consultations.length)];
      const randomBranch = branches[Math.floor(Math.random() * branches.length)];
      const daysFromNow = Math.floor(Math.random() * 30) + 1; // 1-30 days from now
      const preferredDate = generateFutureDate(daysFromNow);
      const preferredTimeSlots = generateTimeSlots();

      const booking = new Booking({
        userId: user._id,
        consultationId: randomConsultation._id,
        fullName: user.fullName,
        mobileNumber: user.phoneNumber || '+919876543210',
        email: user.email,
        branchId: randomBranch._id,
        preferredLocation: randomBranch.name,
        preferredDate,
        preferredTimeSlots,
        status: 'Awaiting Confirmation',
        amount: randomConsultation.price || 0,
        notes: `Fake appointment for testing - Booking ${i + 1}`
      });

      await booking.save();
      bookings.push(booking);

      console.log(`
✅ Booking ${i + 1} created successfully:
   - Reference: ${booking.referenceNumber}
   - Consultation: ${randomConsultation.name}
   - Branch: ${randomBranch.name}
   - Date: ${preferredDate.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
   - Time Slots: ${preferredTimeSlots.join(', ')}
   - Status: ${booking.status}
   - Amount: ₹${booking.amount}
      `);
    }

    console.log(`
✅ Successfully created ${bookings.length} fake appointments for ${user.email}
   
Summary:
- User: ${user.fullName}
- Email: ${user.email}
- Phone: ${user.phoneNumber || 'N/A'}
- Total Bookings: ${bookings.length}
- Consultations Used: ${consultations.length}
- Branches Used: ${branches.length}

All bookings are in "Awaiting Confirmation" status and ready for admin confirmation.
    `);

    await mongoose.connection.close();
    console.log('✅ Database connection closed');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error booking appointments:', error.message);
    console.error(error);
    process.exit(1);
  }
};

// Run the script
bookFakeAppointments();
