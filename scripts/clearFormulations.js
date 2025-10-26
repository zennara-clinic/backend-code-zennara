require('dotenv').config();
const mongoose = require('mongoose');
const Formulation = require('../models/Formulation');

const clearAllFormulations = async () => {
  try {
    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    console.log('🗑️  Clearing all formulations...');
    const result = await Formulation.deleteMany({});
    
    console.log(`✅ Successfully deleted ${result.deletedCount} formulations`);
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error clearing formulations:', error);
    process.exit(1);
  }
};

clearAllFormulations();
