const dotenv = require('dotenv');
const path = require('path');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '.env') });

const mongoose = require('mongoose');
const NotificationHelper = require('./utils/notificationHelper');

// Connect to database
const connectDB = async () => {
  try {
    if (!process.env.MONGODB_URI) {
      console.error('❌ MONGODB_URI not found in environment variables');
      process.exit(1);
    }
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log('✅ MongoDB connected');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

// Test notification creation
const testOrderNotification = async () => {
  try {
    console.log('\n🧪 Testing "New Order Placed" notification creation...\n');

    const testOrder = {
      _id: new mongoose.Types.ObjectId(),
      orderNumber: 'TEST' + Date.now(),
      totalAmount: 1599.99,
      shippingAddress: { name: 'Test Customer' }
    };

    console.log('📦 Test order data:', testOrder);

    const notification = await NotificationHelper.orderCreated(testOrder);

    console.log('\n✅ Notification created successfully!');
    console.log('📋 Notification details:', {
      id: notification._id,
      type: notification.type,
      title: notification.title,
      message: notification.message,
      priority: notification.priority,
      isRead: notification.isRead
    });

    console.log('\n🎉 Test passed! "New Order Placed" notifications are working correctly.');

  } catch (error) {
    console.error('\n❌ Test failed! Error:', error);
    console.error('Stack:', error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\n👋 Database connection closed');
  }
};

// Run the test
connectDB().then(() => {
  testOrderNotification();
});
