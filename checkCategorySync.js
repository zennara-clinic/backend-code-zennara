const mongoose = require('mongoose');
require('dotenv').config();

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI || 'your-mongodb-uri')
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB connection error:', err));

const Consultation = require('./models/Consultation');
const Category = require('./models/Category');

async function checkCategories() {
  try {
    console.log('\n📊 CATEGORY SYNC DIAGNOSTIC\n');
    
    // Get all consultations with their categories
    const consultations = await Consultation.find({ isActive: true }).select('name category');
    console.log(`Total Active Consultations: ${consultations.length}\n`);
    
    // Group consultations by category
    const categoryMap = {};
    consultations.forEach(consult => {
      if (!categoryMap[consult.category]) {
        categoryMap[consult.category] = [];
      }
      categoryMap[consult.category].push(consult.name);
    });
    
    console.log('📋 Consultations grouped by category:');
    Object.keys(categoryMap).sort().forEach(cat => {
      console.log(`  "${cat}": ${categoryMap[cat].length} services`);
      categoryMap[cat].forEach(name => console.log(`    - ${name}`));
    });
    
    console.log('\n📁 Existing Category Documents:');
    const categories = await Category.find().sort({ name: 1 });
    categories.forEach(cat => {
      console.log(`  "${cat.name}" (count: ${cat.consultationCount}, active: ${cat.isActive})`);
    });
    
    console.log('\n🔍 Category Name Match Analysis:');
    const categoryNames = categories.map(c => c.name);
    const consultationCategories = Object.keys(categoryMap);
    
    console.log('\nCategories in DB but not in consultations:');
    categoryNames.forEach(cat => {
      if (!consultationCategories.includes(cat)) {
        console.log(`  ❌ "${cat}"`);
      }
    });
    
    console.log('\nCategories in consultations but not in Category DB:');
    consultationCategories.forEach(cat => {
      if (!categoryNames.includes(cat)) {
        console.log(`  ⚠️ "${cat}"`);
      }
    });
    
    console.log('\n✅ Matching categories:');
    consultationCategories.forEach(cat => {
      if (categoryNames.includes(cat)) {
        console.log(`  ✓ "${cat}" - ${categoryMap[cat].length} services`);
      }
    });
    
  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.connection.close();
    console.log('\n✅ Database connection closed');
  }
}

checkCategories();
