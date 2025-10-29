const dotenv = require('dotenv');
const path = require('path');

// Load environment variables
dotenv.config({ path: path.join(__dirname, '.env') });

const mongoose = require('mongoose');
const NotificationHelper = require('./utils/notificationHelper');
const ProductOrder = require('./models/ProductOrder');
const Booking = require('./models/Booking');
const Inventory = require('./models/Inventory');
const Product = require('./models/Product');
const Consultation = require('./models/Consultation');

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

// Generate test notifications from existing data
const generateTestNotifications = async () => {
  try {
    console.log('🔔 Starting test notification generation...\n');

    // Get recent orders
    const orders = await ProductOrder.find()
      .sort({ createdAt: -1 })
      .limit(3)
      .populate('items.productId');
    
    for (const order of orders) {
      await NotificationHelper.orderCreated({
        _id: order._id,
        orderNumber: order.orderNumber,
        totalAmount: order.pricing.total,
        shippingAddress: { name: order.shippingAddress.fullName }
      });
      console.log(`✅ Created notification for order: ${order.orderNumber}`);
    }

    // Get recent bookings
    const bookings = await Booking.find()
      .sort({ createdAt: -1 })
      .limit(3)
      .populate('consultationId')
      .populate('branchId');
    
    for (const booking of bookings) {
      await NotificationHelper.bookingCreated({
        _id: booking._id,
        patientName: booking.fullName,
        consultation: { name: booking.consultationId?.name || 'Consultation' },
        branch: { name: booking.branchId?.name || booking.preferredLocation },
        appointmentDate: booking.preferredDate
      });
      console.log(`✅ Created notification for booking: ${booking.referenceNumber}`);
    }

    // Get low stock items
    const lowStockItems = await Inventory.find({
      qohAllBatches: { $lte: 5, $gt: 0 }
    }).limit(3);
    
    for (const item of lowStockItems) {
      await NotificationHelper.lowStockAlert({
        _id: item._id,
        product: { name: item.inventoryName },
        quantity: item.qohAllBatches,
        branch: { name: item.branch || 'Main Branch' }
      });
      console.log(`✅ Created low stock alert for: ${item.inventoryName}`);
    }

    // Get recent products
    const products = await Product.find({ isActive: true })
      .sort({ createdAt: -1 })
      .limit(2);
    
    for (const product of products) {
      await NotificationHelper.productCreated({
        _id: product._id,
        name: product.name,
        price: product.price
      });
      console.log(`✅ Created notification for product: ${product.name}`);
    }

    // Get recent consultations
    const consultations = await Consultation.find()
      .sort({ createdAt: -1 })
      .limit(2);
    
    for (const consultation of consultations) {
      await NotificationHelper.consultationCreated({
        _id: consultation._id,
        name: consultation.name,
        price: consultation.price
      });
      console.log(`✅ Created notification for consultation: ${consultation.name}`);
    }

    console.log('\n🎉 Test notifications generated successfully!');
  } catch (error) {
    console.error('❌ Error generating notifications:', error);
  } finally {
    await mongoose.connection.close();
    console.log('👋 Database connection closed');
  }
};

// Run the script
connectDB().then(() => {
  generateTestNotifications();
});
