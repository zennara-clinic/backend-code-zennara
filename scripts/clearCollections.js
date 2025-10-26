require('dotenv').config();
const mongoose = require('mongoose');
const readline = require('readline');

// Import models
const Booking = require('../models/Booking');
const User = require('../models/User');
const ProductOrder = require('../models/ProductOrder');
const Review = require('../models/Review');
const PackageAssignment = require('../models/PackageAssignment');
const Consultation = require('../models/Consultation');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const collections = {
  1: { name: 'Bookings', model: Booking },
  2: { name: 'Users', model: User },
  3: { name: 'Product Orders', model: ProductOrder },
  4: { name: 'Reviews', model: Review },
  5: { name: 'Package Assignments', model: PackageAssignment },
  6: { name: 'Consultations', model: Consultation },
  7: { name: 'All Collections', model: 'ALL' }
};

const clearCollections = async () => {
  try {
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB\n');

    console.log('📋 Select collection to clear:');
    console.log('================================');
    Object.entries(collections).forEach(([key, value]) => {
      console.log(`${key}. ${value.name}`);
    });
    console.log('0. Cancel\n');

    rl.question('Enter your choice (0-7): ', async (choice) => {
      const selection = parseInt(choice);

      if (selection === 0) {
        console.log('❌ Operation cancelled');
        process.exit(0);
      }

      if (!collections[selection]) {
        console.log('❌ Invalid choice');
        process.exit(1);
      }

      const collectionName = collections[selection].name;

      rl.question(`⚠️  Are you sure you want to delete ALL ${collectionName}? (yes/no): `, async (confirm) => {
        if (confirm.toLowerCase() !== 'yes') {
          console.log('❌ Operation cancelled');
          process.exit(0);
        }

        try {
          console.log(`\n🗑️  Clearing ${collectionName}...`);

          if (selection === 7) {
            // Clear all collections
            let totalDeleted = 0;
            for (const [key, value] of Object.entries(collections)) {
              if (key !== '7') {
                const result = await value.model.deleteMany({});
                console.log(`  ✅ Deleted ${result.deletedCount} ${value.name}`);
                totalDeleted += result.deletedCount;
              }
            }
            console.log(`\n🎉 Successfully deleted ${totalDeleted} total documents`);
          } else {
            // Clear single collection
            const result = await collections[selection].model.deleteMany({});
            console.log(`\n🎉 Successfully deleted ${result.deletedCount} ${collectionName}`);
          }

          process.exit(0);
        } catch (error) {
          console.error('❌ Error clearing collections:', error);
          process.exit(1);
        }
      });
    });
  } catch (error) {
    console.error('❌ Error connecting to database:', error);
    process.exit(1);
  }
};

clearCollections();
