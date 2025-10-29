const dotenv = require('dotenv');
const path = require('path');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '.env') });

const mongoose = require('mongoose');
const Notification = require('./models/Notification');

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

// Check notifications
const checkNotifications = async () => {
  try {
    console.log('\n🔍 Checking notifications in database...\n');

    // Get all notifications grouped by title
    const allNotifications = await Notification.find().sort({ createdAt: -1 }).limit(20);
    
    console.log(`📊 Total notifications in database: ${allNotifications.length}\n`);

    // Group by title
    const grouped = {};
    allNotifications.forEach(notif => {
      if (!grouped[notif.title]) {
        grouped[notif.title] = [];
      }
      grouped[notif.title].push(notif);
    });

    console.log('📋 Notifications by title:');
    Object.keys(grouped).forEach(title => {
      console.log(`  - ${title}: ${grouped[title].length} notification(s)`);
    });

    // Check specifically for "New Order Placed"
    const newOrderNotifications = await Notification.find({ 
      title: 'New Order Placed' 
    }).sort({ createdAt: -1 }).limit(5);

    console.log(`\n🆕 "New Order Placed" notifications: ${newOrderNotifications.length}`);
    if (newOrderNotifications.length > 0) {
      console.log('\nMost recent "New Order Placed" notifications:');
      newOrderNotifications.forEach((notif, index) => {
        console.log(`${index + 1}. ${notif.message}`);
        console.log(`   Created: ${notif.createdAt}`);
        console.log(`   Read: ${notif.isRead}`);
        console.log(`   Priority: ${notif.priority}`);
        console.log('');
      });
    } else {
      console.log('❌ No "New Order Placed" notifications found in database!');
      console.log('   This confirms that notifications are NOT being created when orders are placed.');
    }

    // Check for "Order Status Updated"
    const statusUpdateNotifications = await Notification.find({ 
      title: 'Order Status Updated' 
    }).sort({ createdAt: -1 }).limit(5);

    console.log(`\n📝 "Order Status Updated" notifications: ${statusUpdateNotifications.length}`);
    if (statusUpdateNotifications.length > 0) {
      console.log('\nMost recent "Order Status Updated" notifications:');
      statusUpdateNotifications.forEach((notif, index) => {
        console.log(`${index + 1}. ${notif.message}`);
        console.log(`   Created: ${notif.createdAt}`);
        console.log(`   Read: ${notif.isRead}`);
        console.log('');
      });
    }

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.connection.close();
    console.log('\n👋 Database connection closed');
  }
};

// Run the check
connectDB().then(() => {
  checkNotifications();
});
