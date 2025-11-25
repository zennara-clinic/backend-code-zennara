const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const dotenv = require('dotenv');
const path = require('path');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '.env') });

// Import models
const User = require('./models/User');
const Booking = require('./models/Booking');
const ProductOrder = require('./models/ProductOrder');
const Product = require('./models/Product');
const Consultation = require('./models/Consultation');
const Branch = require('./models/Branch');

// Demo account credentials
const DEMO_PHONE = '8945515335';
const DEMO_OTP = '9876';
const DEMO_EMAIL = 'applereview@zennara.com';

async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/zennara', {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log('✅ MongoDB connected');
  } catch (error) {
    console.error('❌ MongoDB connection failed:', error);
    process.exit(1);
  }
}

async function createDemoUser() {
  try {
    // Check if demo user already exists
    let demoUser = await User.findOne({ phone: DEMO_PHONE });
    
    if (demoUser) {
      console.log('🔄 Demo user already exists, updating...');
      // Update existing user
      demoUser.email = DEMO_EMAIL;
      demoUser.fullName = 'Apple Review Demo';
      demoUser.location = 'Jubilee Hills';
      demoUser.dateOfBirth = new Date('1990-01-01');
      demoUser.gender = 'Male';
      demoUser.isVerified = true;
      demoUser.emailVerified = true;
    } else {
      console.log('✨ Creating new demo user...');
      // Create new user
      demoUser = new User({
        phone: DEMO_PHONE,
        email: DEMO_EMAIL,
        fullName: 'Apple Review Demo',
        location: 'Jubilee Hills',
        dateOfBirth: new Date('1990-01-01'),
        gender: 'Male',
        isVerified: true,
        emailVerified: true
      });
    }
    
    // Set as Zen Member with active membership
    demoUser.memberType = 'Zen Member';
    demoUser.zenMembershipStartDate = new Date();
    const expiryDate = new Date();
    expiryDate.setMonth(expiryDate.getMonth() + 6); // 6 months membership
    demoUser.zenMembershipExpiryDate = expiryDate;
    demoUser.zenMembershipAutoRenew = true;
    
    // Set profile details
    demoUser.medicalHistory = 'No significant medical history';
    demoUser.drugAllergies = 'None';
    demoUser.dietaryPreferences = 'Vegetarian';
    demoUser.smoking = 'No';
    demoUser.drinking = 'Occasionally';
    demoUser.additionalInfo = 'Demo account for Apple App Store review';
    
    // Save user
    await demoUser.save();
    console.log('✅ Demo user created/updated successfully');
    
    return demoUser;
  } catch (error) {
    console.error('❌ Error creating demo user:', error);
    throw error;
  }
}

async function createDemoAppointments(userId) {
  try {
    console.log('📅 Creating demo appointments...');
    
    // Delete existing demo appointments for this user
    await Booking.deleteMany({ userId: userId });
    
    // Get consultations and branches
    const consultations = await Consultation.find({ isActive: true }).limit(5);
    const branches = await Branch.find({ isActive: true }).limit(3);
    
    if (consultations.length === 0) {
      console.log('⚠️ No consultations found. Creating with default consultation ID.');
    }
    
    // Use first consultation or create a placeholder ObjectId
    const defaultConsultationId = consultations[0]?._id || new mongoose.Types.ObjectId();
    const defaultBranchId = branches[0]?._id;
    const defaultLocation = branches[0]?.name || 'Jubilee Hills';
    
    const appointments = [
      // Completed appointments (past)
      {
        userId: userId,
        consultationId: consultations[0]?._id || defaultConsultationId,
        fullName: 'Apple Review Demo',
        mobileNumber: DEMO_PHONE,
        email: DEMO_EMAIL,
        branchId: defaultBranchId,
        preferredLocation: defaultLocation,
        preferredDate: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000), // 20 days ago
        preferredTimeSlots: ['10:00 AM'],
        confirmedDate: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
        confirmedTime: '10:00 AM',
        status: 'Completed',
        paymentStatus: 'paid',
        amount: consultations[0]?.price || 1500,
        rating: 5,
        feedback: 'Excellent consultation! Very helpful and professional.',
        ratedAt: new Date(Date.now() - 19 * 24 * 60 * 60 * 1000),
        notes: 'Initial skin consultation - Completed successfully'
      },
      {
        userId: userId,
        consultationId: consultations[1]?._id || defaultConsultationId,
        fullName: 'Apple Review Demo',
        mobileNumber: DEMO_PHONE,
        email: DEMO_EMAIL,
        branchId: defaultBranchId,
        preferredLocation: defaultLocation,
        preferredDate: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000), // 10 days ago
        preferredTimeSlots: ['2:00 PM'],
        confirmedDate: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
        confirmedTime: '2:00 PM',
        status: 'Completed',
        paymentStatus: 'paid',
        amount: consultations[1]?.price || 2000,
        rating: 4,
        feedback: 'Great follow-up session. Seeing good results.',
        ratedAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000),
        notes: 'Follow-up treatment session - Completed'
      },
      // Cancelled appointment
      {
        userId: userId,
        consultationId: consultations[2]?._id || defaultConsultationId,
        fullName: 'Apple Review Demo',
        mobileNumber: DEMO_PHONE,
        email: DEMO_EMAIL,
        branchId: defaultBranchId,
        preferredLocation: defaultLocation,
        preferredDate: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000), // 5 days ago
        preferredTimeSlots: ['11:00 AM'],
        status: 'Cancelled',
        paymentStatus: 'refunded',
        amount: consultations[2]?.price || 1800,
        cancellationReason: 'Schedule conflict - had to reschedule',
        cancelledAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
        notes: 'Cancelled by user due to schedule conflict'
      },
      // Upcoming confirmed appointment
      {
        userId: userId,
        consultationId: consultations[0]?._id || defaultConsultationId,
        fullName: 'Apple Review Demo',
        mobileNumber: DEMO_PHONE,
        email: DEMO_EMAIL,
        branchId: defaultBranchId,
        preferredLocation: defaultLocation,
        preferredDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000), // 3 days from now
        preferredTimeSlots: ['10:00 AM'],
        confirmedDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
        confirmedTime: '10:00 AM',
        status: 'Confirmed',
        paymentStatus: 'paid',
        amount: consultations[0]?.price || 1500,
        notes: 'Upcoming skin treatment session - Confirmed'
      },
      // Upcoming awaiting confirmation
      {
        userId: userId,
        consultationId: consultations[1]?._id || defaultConsultationId,
        fullName: 'Apple Review Demo',
        mobileNumber: DEMO_PHONE,
        email: DEMO_EMAIL,
        branchId: defaultBranchId,
        preferredLocation: defaultLocation,
        preferredDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days from now
        preferredTimeSlots: ['3:00 PM', '4:00 PM'],
        status: 'Awaiting Confirmation',
        paymentStatus: 'pending',
        amount: consultations[1]?.price || 2000,
        notes: 'New booking request - Awaiting confirmation'
      },
      // Another upcoming appointment
      {
        userId: userId,
        consultationId: consultations[2]?._id || defaultConsultationId,
        fullName: 'Apple Review Demo',
        mobileNumber: DEMO_PHONE,
        email: DEMO_EMAIL,
        branchId: branches[1]?._id || defaultBranchId,
        preferredLocation: branches[1]?.name || defaultLocation,
        preferredDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000), // 14 days from now
        preferredTimeSlots: ['11:00 AM'],
        confirmedDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        confirmedTime: '11:00 AM',
        status: 'Confirmed',
        paymentStatus: 'paid',
        amount: consultations[2]?.price || 1800,
        notes: 'Monthly check-up appointment - Confirmed'
      }
    ];
    
    let createdCount = 0;
    for (const appointment of appointments) {
      try {
        const booking = new Booking(appointment);
        await booking.save();
        console.log(`  ✅ Created: ${appointment.status} - ${appointment.notes}`);
        createdCount++;
      } catch (err) {
        console.log(`  ⚠️ Skipped appointment: ${err.message}`);
      }
    }
    
    console.log(`✅ Created ${createdCount} demo appointments successfully`);
  } catch (error) {
    console.error('❌ Error creating demo appointments:', error.message);
  }
}

async function createDemoOrders(userId) {
  try {
    console.log('🛍️ Creating demo product orders...');
    
    // Delete existing demo orders
    await ProductOrder.deleteMany({ userId: userId });
    
    // Get sample products
    const products = await Product.find({ isActive: true }).limit(5);
    
    if (products.length === 0) {
      console.log('⚠️ No products found. Skipping orders.');
      return;
    }
    
    const orders = [
      {
        userId: userId,
        orderNumber: 'ORD-DEMO-001',
        items: [
          {
            productId: products[0]?._id,
            productName: products[0]?.name || 'Skin Care Serum',
            productImage: products[0]?.images?.[0] || '',
            price: products[0]?.price || 1200,
            quantity: 2,
            subtotal: (products[0]?.price || 1200) * 2
          },
          {
            productId: products[1]?._id || products[0]?._id,
            productName: products[1]?.name || 'Face Wash',
            productImage: products[1]?.images?.[0] || '',
            price: products[1]?.price || 500,
            quantity: 1,
            subtotal: products[1]?.price || 500
          }
        ],
        pricing: {
          subtotal: ((products[0]?.price || 1200) * 2) + (products[1]?.price || 500),
          gst: 0,
          discount: 0,
          deliveryFee: 0,
          total: ((products[0]?.price || 1200) * 2) + (products[1]?.price || 500)
        },
        paymentMethod: 'Razorpay',
        paymentStatus: 'Paid',
        orderStatus: 'Delivered',
        shippingAddress: {
          fullName: 'Apple Review Demo',
          phone: DEMO_PHONE,
          addressLine1: '123 Demo Street',
          addressLine2: 'Near Apollo Hospital',
          city: 'Hyderabad',
          state: 'Telangana',
          postalCode: '500033',
          country: 'India'
        },
        deliveredAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), // Delivered 3 days ago
        createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // Created 7 days ago
      },
      {
        userId: userId,
        orderNumber: 'ORD-DEMO-002',
        items: [
          {
            productId: products[2]?._id || products[0]?._id,
            productName: products[2]?.name || 'Hair Oil',
            productImage: products[2]?.images?.[0] || '',
            price: products[2]?.price || 800,
            quantity: 1,
            subtotal: products[2]?.price || 800
          }
        ],
        pricing: {
          subtotal: products[2]?.price || 800,
          gst: 0,
          discount: 0,
          deliveryFee: 0,
          total: products[2]?.price || 800
        },
        paymentMethod: 'COD',
        paymentStatus: 'Pending',
        orderStatus: 'Processing',
        shippingAddress: {
          fullName: 'Apple Review Demo',
          phone: DEMO_PHONE,
          addressLine1: '123 Demo Street',
          addressLine2: 'Near Apollo Hospital',
          city: 'Hyderabad',
          state: 'Telangana',
          postalCode: '500033',
          country: 'India'
        },
        createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) // Created 2 days ago
      },
      {
        userId: userId,
        orderNumber: 'ORD-DEMO-003',
        items: [
          {
            productId: products[3]?._id || products[0]?._id,
            productName: products[3]?.name || 'Moisturizer',
            productImage: products[3]?.images?.[0] || '',
            price: products[3]?.price || 1500,
            quantity: 1,
            subtotal: products[3]?.price || 1500
          },
          {
            productId: products[4]?._id || products[1]?._id,
            productName: products[4]?.name || 'Sunscreen',
            productImage: products[4]?.images?.[0] || '',
            price: products[4]?.price || 900,
            quantity: 2,
            subtotal: (products[4]?.price || 900) * 2
          }
        ],
        pricing: {
          subtotal: (products[3]?.price || 1500) + ((products[4]?.price || 900) * 2),
          gst: 0,
          discount: 0,
          deliveryFee: 0,
          total: (products[3]?.price || 1500) + ((products[4]?.price || 900) * 2)
        },
        paymentMethod: 'Razorpay',
        paymentStatus: 'Paid',
        orderStatus: 'Shipped',
        trackingNumber: 'TRACK-DEMO-12345',
        shippingAddress: {
          fullName: 'Apple Review Demo',
          phone: DEMO_PHONE,
          addressLine1: '123 Demo Street',
          addressLine2: 'Near Apollo Hospital',
          city: 'Hyderabad',
          state: 'Telangana',
          postalCode: '500033',
          country: 'India'
        },
        createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000) // Created 1 day ago
      }
    ];
    
    for (const order of orders) {
      const productOrder = new ProductOrder(order);
      await productOrder.save();
      console.log(`  ✅ Created order: ${order.orderNumber} - ${order.orderStatus}`);
    }
    
    console.log('✅ Demo orders created successfully');
  } catch (error) {
    console.error('❌ Error creating demo orders:', error);
  }
}

async function setupDemoAccount() {
  try {
    console.log('🚀 Starting demo account setup...');
    console.log('================================');
    console.log('Demo Phone: ' + DEMO_PHONE);
    console.log('Demo OTP: ' + DEMO_OTP);
    console.log('================================\n');
    
    // Connect to database
    await connectDB();
    
    // Create demo user
    const demoUser = await createDemoUser();
    
    // Create demo appointments
    await createDemoAppointments(demoUser._id);
    
    // Create demo orders
    await createDemoOrders(demoUser._id);
    
    console.log('\n================================');
    console.log('✅ Demo account setup completed!');
    console.log('================================');
    console.log('Demo Account Details:');
    console.log('  Phone: ' + DEMO_PHONE);
    console.log('  OTP: ' + DEMO_OTP);
    console.log('  Email: ' + DEMO_EMAIL);
    console.log('  Name: Apple Review Demo');
    console.log('  Membership: Zen Member (Active)');
    console.log('================================\n');
    
  } catch (error) {
    console.error('❌ Setup failed:', error);
  } finally {
    // Close database connection
    await mongoose.connection.close();
    console.log('Database connection closed');
  }
}

// Run the setup
setupDemoAccount();
