const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Product = require('../models/Product');
const connectDB = require('../config/db');

dotenv.config();

const products = [
  {
    name: 'First Aid Emergency Kit',
    description: 'Complete emergency first aid kit with 100+ essential items including bandages, antiseptics, gauze, scissors, and emergency supplies for home and travel',
    category: 'First Aid',
    brand: 'Zennara Safety',
    price: 899,
    zenMemberPrice: 809,
    image: 'https://images.unsplash.com/photo-1603398938378-e54eab446dde?w=600&h=400&fit=crop',
    stock: 50,
    rating: 4.9,
    reviews: 234,
    isActive: true,
    isPopular: true
  },
  {
    name: 'Digital Infrared Thermometer',
    description: 'Fast and accurate contactless infrared thermometer with LCD display, fever alarm, and memory function for safe temperature monitoring',
    category: 'First Aid',
    brand: 'Zennara Health',
    price: 399,
    zenMemberPrice: 359,
    image: 'https://images.unsplash.com/photo-1584515979956-d9f6e5d09982?w=600&h=400&fit=crop',
    stock: 75,
    rating: 4.7,
    reviews: 189,
    isActive: true,
    isPopular: true
  },
  {
    name: 'Pain Relief Gel - Fast Action',
    description: 'Advanced topical pain relief gel with diclofenac for quick relief from muscle pain, joint pain, backache, and sports injuries',
    category: 'Pain Relief',
    brand: 'Zennara Care',
    price: 249,
    zenMemberPrice: 224,
    image: 'https://images.unsplash.com/photo-1587854692152-cbe660dbde88?w=600&h=400&fit=crop',
    stock: 120,
    rating: 4.6,
    reviews: 456,
    isActive: true,
    isPopular: true
  },
  {
    name: 'Ibuprofen Pain Relief Tablets',
    description: 'Effective pain and fever relief tablets (200mg) for headaches, dental pain, menstrual cramps, and minor aches. Pack of 20 tablets',
    category: 'Pain Relief',
    brand: 'Zennara Pharma',
    price: 129,
    zenMemberPrice: 116,
    image: 'https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=600&h=400&fit=crop',
    stock: 200,
    rating: 4.5,
    reviews: 678,
    isActive: true
  },
  {
    name: 'Hand Sanitizer Gel - 500ml',
    description: '70% alcohol-based instant hand sanitizer with aloe vera and vitamin E. Kills 99.9% germs without water. Refreshing fragrance',
    category: 'Personal Care',
    brand: 'Zennara Care',
    price: 199,
    zenMemberPrice: 179,
    image: 'https://images.unsplash.com/photo-1584744982491-665216d95f8b?w=600&h=400&fit=crop',
    stock: 150,
    rating: 4.4,
    reviews: 892,
    isActive: true,
    isPopular: true
  },
  {
    name: 'Premium Surgical Face Masks',
    description: '3-layer disposable surgical face masks with nose clip and elastic ear loops. BFE >95%. Pack of 50 masks for everyday protection',
    category: 'Personal Care',
    brand: 'Zennara Safety',
    price: 299,
    zenMemberPrice: 269,
    image: 'https://images.unsplash.com/photo-1603398938378-e54eab446dde?w=600&h=400&fit=crop',
    stock: 300,
    rating: 4.3,
    reviews: 1234,
    isActive: true
  },
  {
    name: 'Hyaluronic Acid Face Serum',
    description: 'Intensive hydrating serum with pure hyaluronic acid for deep moisture, plump skin, and reduced fine lines. Suitable for all skin types',
    category: 'Skincare',
    brand: 'Zennara Skincare',
    price: 799,
    zenMemberPrice: 719,
    image: 'https://images.unsplash.com/photo-1620916566398-39f1143ab7be?w=600&h=400&fit=crop',
    stock: 80,
    rating: 4.8,
    reviews: 567,
    isActive: true,
    isPopular: true
  },
  {
    name: 'Vitamin C Brightening Face Wash',
    description: 'Daily brightening face wash enriched with vitamin C, citrus extracts, and natural ingredients for glowing, radiant skin',
    category: 'Skincare',
    brand: 'Zennara Skincare',
    price: 449,
    zenMemberPrice: 404,
    image: 'https://images.unsplash.com/photo-1556228578-dd6a04c70494?w=600&h=400&fit=crop',
    stock: 100,
    rating: 4.6,
    reviews: 423,
    isActive: true
  },
  {
    name: 'Multivitamin Complete Tablets',
    description: 'Daily multivitamin with 25+ essential vitamins and minerals including A, B complex, C, D, E, zinc, and iron for complete nutrition',
    category: 'Supplements',
    brand: 'Zennara Health',
    price: 349,
    zenMemberPrice: 314,
    image: 'https://images.unsplash.com/photo-1556228994-330a5b87e4b9?w=600&h=400&fit=crop',
    stock: 180,
    rating: 4.7,
    reviews: 789,
    isActive: true,
    isPopular: true
  },
  {
    name: 'Omega-3 Fish Oil Capsules',
    description: 'Premium omega-3 fish oil (1000mg) with EPA and DHA for heart health, brain function, and joint support. 60 capsules',
    category: 'Supplements',
    brand: 'Zennara Vitamins',
    price: 699,
    zenMemberPrice: 629,
    image: 'https://images.unsplash.com/photo-1526336024174-e58f5cdd8e13?w=600&h=400&fit=crop',
    stock: 90,
    rating: 4.8,
    reviews: 645,
    isActive: true,
    isPopular: true
  }
];

const seedProducts = async () => {
  try {
    console.log('🔗 Connecting to database...');
    await connectDB();
    
    console.log('🗑️  Clearing existing products...');
    const deleteResult = await Product.deleteMany({});
    console.log(`   ✓ Deleted ${deleteResult.deletedCount} existing products`);
    
    console.log('🌱 Seeding products...');
    const createdProducts = await Product.insertMany(products);
    console.log(`   ✓ Created ${createdProducts.length} new products`);
    
    console.log('\n✅ Products seeded successfully!');
    console.log('\n📊 Summary:');
    console.log(`   • Total products: ${products.length}`);
    console.log(`   • Categories: ${[...new Set(products.map(p => p.category))].join(', ')}`);
    console.log(`   • Popular products: ${products.filter(p => p.isPopular).length}`);
    console.log(`   • Total stock: ${products.reduce((sum, p) => sum + p.stock, 0)} units`);
    
    // Display products by category
    console.log('\n📦 Products by Category:');
    const categories = [...new Set(products.map(p => p.category))];
    categories.forEach(category => {
      const categoryProducts = products.filter(p => p.category === category);
      console.log(`\n   ${category} (${categoryProducts.length} products):`);
      categoryProducts.forEach(p => {
        console.log(`      • ${p.name} - ₹${p.price} (Stock: ${p.stock})`);
      });
    });
    
    console.log('\n🎉 Database is ready! You can now use the Products screen in the mobile app.\n');
    
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Error seeding products:', error);
    console.error('Error details:', error.message);
    process.exit(1);
  }
};

// Run seeder
seedProducts();
