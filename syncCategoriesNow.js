const mongoose = require('mongoose');
require('dotenv').config();

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI || 'your-mongodb-uri')
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

const Consultation = require('./models/Consultation');
const Category = require('./models/Category');

async function syncCategories() {
  try {
    console.log('\n🔄 Starting category sync...\n');
    
    const categories = await Category.find();
    
    for (const category of categories) {
      const count = await Consultation.countDocuments({ 
        category: category.name,
        isActive: true 
      });
      
      category.consultationCount = count;
      await category.save();
      
      console.log(`✅ ${category.name}: ${count} services`);
    }
    
    console.log('\n✅ All categories synced successfully!');
    
    // Show final stats
    const updatedCategories = await Category.find().sort({ name: 1 });
    console.log('\n📊 Final Category Counts:');
    updatedCategories.forEach(cat => {
      console.log(`  ${cat.name}: ${cat.consultationCount} services`);
    });
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.connection.close();
    console.log('\n✅ Database connection closed');
  }
}

syncCategories();
