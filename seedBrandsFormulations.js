const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Brand = require('./models/Brand');
const Formulation = require('./models/Formulation');
const Product = require('./models/Product');

dotenv.config();

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ MongoDB Connected');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

const seedBrandsAndFormulations = async () => {
  try {
    await connectDB();

    // Get unique brands from existing products
    const uniqueBrands = await Product.distinct('OrgName');
    console.log(`\n📦 Found ${uniqueBrands.length} unique brands in products`);

    // Create brands
    const brandPromises = uniqueBrands.map(async (brandName) => {
      const existingBrand = await Brand.findOne({ name: brandName });
      if (!existingBrand) {
        const productsCount = await Product.countDocuments({ OrgName: brandName });
        return Brand.create({
          name: brandName,
          description: `${brandName} - Premium skincare and wellness products`,
          isActive: true,
          productsCount
        });
      }
      return null;
    });

    const createdBrands = (await Promise.all(brandPromises)).filter(b => b !== null);
    console.log(`✅ Created ${createdBrands.length} new brands`);

    // Get unique formulations from existing products
    const uniqueFormulations = await Product.distinct('formulation');
    console.log(`\n🧪 Found ${uniqueFormulations.length} unique formulations in products`);

    // Create formulations
    const formulationPromises = uniqueFormulations.map(async (formulationName) => {
      const existingFormulation = await Formulation.findOne({ name: formulationName });
      if (!existingFormulation) {
        const productsCount = await Product.countDocuments({ formulation: formulationName });
        return Formulation.create({
          name: formulationName,
          description: `${formulationName} formulation for skincare`,
          isActive: true,
          productsCount
        });
      }
      return null;
    });

    const createdFormulations = (await Promise.all(formulationPromises)).filter(f => f !== null);
    console.log(`✅ Created ${createdFormulations.length} new formulations`);

    console.log('\n🎉 Seeding completed successfully!');
    console.log('\n📊 Summary:');
    console.log(`   - Total Brands: ${await Brand.countDocuments()}`);
    console.log(`   - Total Formulations: ${await Formulation.countDocuments()}`);
    console.log(`   - Total Products: ${await Product.countDocuments()}`);

    process.exit(0);
  } catch (error) {
    console.error('❌ Error seeding data:', error);
    process.exit(1);
  }
};

seedBrandsAndFormulations();
