require('dotenv').config();
const mongoose = require('mongoose');

const fixProductCodeIndex = async () => {
  try {
    console.log('🔄 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    const db = mongoose.connection.db;
    const collection = db.collection('products');

    console.log('🔍 Checking existing indexes...');
    const indexes = await collection.indexes();
    console.log('Current indexes:', JSON.stringify(indexes, null, 2));

    // Drop the old code index if it exists
    const codeIndex = indexes.find(idx => idx.name === 'code_1');
    if (codeIndex) {
      console.log('🗑️  Dropping old code_1 index...');
      await collection.dropIndex('code_1');
      console.log('✅ Old index dropped');
    }

    // Create new sparse unique index
    console.log('🔨 Creating new sparse unique index on code...');
    await collection.createIndex(
      { code: 1 }, 
      { 
        unique: true, 
        sparse: true,
        name: 'code_1'
      }
    );
    console.log('✅ New sparse index created');

    console.log('\n📊 Final indexes:');
    const finalIndexes = await collection.indexes();
    console.log(JSON.stringify(finalIndexes, null, 2));

    console.log('\n✨ Index migration completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error fixing index:', error);
    process.exit(1);
  }
};

fixProductCodeIndex();
