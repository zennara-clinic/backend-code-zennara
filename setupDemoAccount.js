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
const ServiceCard = require('./models/ServiceCard');
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
    
    // Delete existing demo appointments
    await Booking.deleteMany({ user: userId });
    
    // Get branches and services
    const branches = await Branch.find().limit(2);
    const services = await ServiceCard.find().limit(3);
    
    if (branches.length === 0 || services.length === 0) {
      console.log('⚠️ No branches or services found. Skipping appointments.');
      return;
    }
    
    const appointments = [
      {
        user: userId,
        service: services[0]?._id,
        branch: branches[0]?._id,
        date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days from now
        time: '10:00 AM',
        status: 'Confirmed',
        paymentStatus: 'Paid',
        paymentMethod: 'Online',
        amount: services[0]?.price || 1500,
        notes: 'Consultation for skin treatment',
        createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) // Created 5 days ago
      },
      {
        user: userId,
        service: services[1]?._id || services[0]?._id,
        branch: branches[0]?._id,
        date: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000), // 10 days ago
        time: '2:00 PM',
        status: 'Completed',
        paymentStatus: 'Paid',
        paymentMethod: 'Online',
        amount: services[1]?.price || 2000,
        notes: 'Hair treatment session completed',
        createdAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000) // Created 15 days ago
      },
      {
        user: userId,
        service: services[2]?._id || services[0]?._id,
        branch: branches[1]?._id || branches[0]?._id,
        date: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000), // 14 days from now
        time: '11:30 AM',
        status: 'Pending',
        paymentStatus: 'Pending',
        paymentMethod: 'Cash',
        amount: services[2]?.price || 1800,
        notes: 'Follow-up consultation',
        createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) // Created 2 days ago
      }
    ];
    
    for (const appointment of appointments) {
      const booking = new Booking(appointment);
      await booking.save();
      console.log(`  ✅ Created appointment: ${appointment.status} - ${appointment.notes}`);
    }
    
    console.log('✅ Demo appointments created successfully');
  } catch (error) {
    console.error('❌ Error creating demo appointments:', error);
  }
}

async function createDemoOrders(userId) {
  try {
    console.log('🛍️ Creating demo product orders...');
    
    // Delete existing demo orders
    await ProductOrder.deleteMany({ user: userId });
    
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
