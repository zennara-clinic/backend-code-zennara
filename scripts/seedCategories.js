const mongoose = require('mongoose');
require('dotenv').config();
const Consultation = require('../models/Consultation');
const Category = require('../models/Category');

// MongoDB Connection
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ MongoDB Connected Successfully');
  } catch (error) {
    console.error('❌ MongoDB Connection Error:', error.message);
    process.exit(1);
  }
};

// Seed categories from existing consultations
const seedCategories = async () => {
  try {
    console.log('🔄 Starting to seed categories...');

    // Get distinct categories from existing consultations
    const distinctCategories = await Consultation.distinct('category');
    console.log(`📋 Found ${distinctCategories.length} unique categories in consultations`);

    // Create categories in Category model
    let createdCount = 0;
    let skippedCount = 0;

    for (const categoryName of distinctCategories) {
      if (!categoryName) continue; // Skip empty categories

      // Check if category already exists
      const exists = await Category.findOne({ name: categoryName });
      
      if (!exists) {
        // Count consultations in this category
        const consultationCount = await Consultation.countDocuments({ 
          category: categoryName,
          isActive: true 
        });

        await Category.create({
          name: categoryName,
          consultationCount: consultationCount
        });
        
        console.log(`   ✅ Created category: ${categoryName} (${consultationCount} consultations)`);
        createdCount++;
      } else {
        console.log(`   ⏭️  Skipped existing category: ${categoryName}`);
        skippedCount++;
      }
    }

    console.log(`\n✨ Category seeding completed!`);
    console.log(`   📊 Created: ${createdCount} categories`);
    console.log(`   ⏭️  Skipped: ${skippedCount} existing categories`);
    console.log(`   📋 Total: ${distinctCategories.length} categories\n`);

    // Show all categories
    const allCategories = await Category.find().sort({ name: 1 });
    console.log('📚 All Categories:');
    allCategories.forEach(cat => {
      console.log(`   - ${cat.name} (${cat.consultationCount} consultations)`);
    });

  } catch (error) {
    console.error('❌ Error seeding categories:', error);
    throw error;
  }
};

// Main execution
const main = async () => {
  try {
    await connectDB();
    await seedCategories();
    console.log('\n✅ Script completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('❌ Script failed:', error);
    process.exit(1);
  }
};

// Run the script
main();
