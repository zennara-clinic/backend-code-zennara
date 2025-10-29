require('dotenv').config();
const mongoose = require('mongoose');
const ProductOrder = require('./models/ProductOrder');

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

const clearAllOrders = async () => {
  try {
    console.log('🔄 Connecting to database...');
    
    // Count orders before deletion
    const orderCount = await ProductOrder.countDocuments();
    console.log(`📊 Found ${orderCount} orders in the database`);
    
    if (orderCount === 0) {
      console.log('✅ No orders to clear. Database is already empty.');
      process.exit(0);
    }
    
    // Ask for confirmation
    console.log('\n⚠️  WARNING: This will permanently delete ALL orders from the database!');
    console.log('This action cannot be undone.\n');
    
    // In production, you might want to add a confirmation prompt
    // For now, we'll proceed with the deletion
    
    console.log('🗑️  Clearing all orders...');
    
    // Delete all orders
    const result = await ProductOrder.deleteMany({});
    
    console.log(`✅ Successfully deleted ${result.deletedCount} orders`);
    console.log('🎉 All orders have been cleared from the database');
    
  } catch (error) {
    console.error('❌ Error clearing orders:', error);
    process.exit(1);
  } finally {
    // Close database connection
    await mongoose.connection.close();
    console.log('🔌 Database connection closed');
    process.exit(0);
  }
};

// Run the function
clearAllOrders();
