const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Product = require('./models/Product');
const connectDB = require('./config/db');

dotenv.config();

const products = [
  {
    name: 'Hyaluronic Acid Serum',
    description: 'Intensive hydrating serum for plump, moisturized skin',
    category: 'Skincare',
    brand: 'Zennara Skincare',
    price: 699,
    zenMemberPrice: 629,
    image: 'https://images.unsplash.com/photo-1620916566398-39f1143ab7be?w=600&h=400&fit=crop',
    stock: 50,
    rating: 4.8,
    reviews: 145,
    isActive: true,
    isPopular: true
  },
  {
    name: 'Probiotic Capsules',
    description: 'Advanced digestive health support with 10 billion CFU',
    category: 'Supplements',
    brand: 'Zennara Health',
    price: 449,
    zenMemberPrice: 404,
    image: 'https://images.unsplash.com/photo-1584308666744-24d5c474f2ae?w=600&h=400&fit=crop',
    stock: 75,
    rating: 4.7,
    reviews: 92,
    isActive: true,
    isPopular: true
  },
  {
    name: 'Calcium + Vitamin D3',
    description: 'Bone health supplement with calcium carbonate and vitamin D3',
    category: 'Supplements',
    brand: 'Zennara Vitamins',
    price: 349,
    zenMemberPrice: 314,
    image: 'https://images.unsplash.com/photo-1505751172876-fa1923c5c528?w=600&h=400&fit=crop',
    stock: 60,
    rating: 4.3,
    reviews: 112,
    isActive: true
  },
  {
    name: 'Multivitamin Tablets',
    description: 'Complete daily nutrition supplement with essential vitamins',
    category: 'Supplements',
    brand: 'Zennara Health',
    price: 299,
    zenMemberPrice: 269,
    image: 'https://images.unsplash.com/photo-1556228994-330a5b87e4b9?w=600&h=400&fit=crop',
    stock: 100,
    rating: 4.6,
    reviews: 203,
    isActive: true,
    isPopular: true
  },
  {
    name: 'Pain Relief Gel',
    description: 'Fast-acting topical pain relief for muscle and joint pain',
    category: 'Pain Relief',
    brand: 'Zennara Care',
    price: 199,
    zenMemberPrice: 179,
    image: 'https://images.unsplash.com/photo-1587854692152-cbe660dbde88?w=600&h=400&fit=crop',
    stock: 80,
    rating: 4.5,
    reviews: 78,
    isActive: true
  },
  {
    name: 'First Aid Kit',
    description: 'Complete emergency first aid kit for home and travel',
    category: 'First Aid',
    brand: 'Zennara Safety',
    price: 899,
    zenMemberPrice: 809,
    image: 'https://images.unsplash.com/photo-1603398938378-e54eab446dde?w=600&h=400&fit=crop',
    stock: 30,
    rating: 4.9,
    reviews: 156,
    isActive: true,
    isPopular: true
  },
  {
    name: 'Vitamin C Face Wash',
    description: 'Brightening face wash with vitamin C and natural extracts',
    category: 'Skincare',
    brand: 'Zennara Skincare',
    price: 399,
    zenMemberPrice: 359,
    image: 'https://images.unsplash.com/photo-1556228578-dd6a04c70494?w=600&h=400&fit=crop',
    stock: 65,
    rating: 4.4,
    reviews: 89,
    isActive: true
  },
  {
    name: 'Hand Sanitizer Pack',
    description: '70% alcohol-based hand sanitizer, pack of 3',
    category: 'Personal Care',
    brand: 'Zennara Care',
    price: 249,
    zenMemberPrice: 224,
    image: 'https://images.unsplash.com/photo-1584744982491-665216d95f8b?w=600&h=400&fit=crop',
    stock: 120,
    rating: 4.2,
    reviews: 234,
    isActive: true
  },
  {
    name: 'Digital Thermometer',
    description: 'Fast and accurate digital thermometer for home use',
    category: 'First Aid',
    brand: 'Zennara Health',
    price: 299,
    zenMemberPrice: 269,
    image: 'https://images.unsplash.com/photo-1584515979956-d9f6e5d09982?w=600&h=400&fit=crop',
    stock: 45,
    rating: 4.6,
    reviews: 67,
    isActive: true
  },
  {
    name: 'Omega-3 Fish Oil',
    description: 'Premium omega-3 fish oil for heart and brain health',
    category: 'Supplements',
    brand: 'Zennara Vitamins',
    price: 599,
    zenMemberPrice: 539,
    image: 'https://images.unsplash.com/photo-1526336024174-e58f5cdd8e13?w=600&h=400&fit=crop',
    stock: 55,
    rating: 4.7,
    reviews: 123,
    isActive: true,
    isPopular: true
  }
];

const seedProducts = async () => {
  try {
    await connectDB();
    
    console.log('🗑️  Clearing existing products...');
    await Product.deleteMany({});
    
    console.log('🌱 Seeding products...');
    await Product.insertMany(products);
    
    console.log('✅ Products seeded successfully!');
    console.log(`📦 Total products: ${products.length}`);
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error seeding products:', error);
    process.exit(1);
  }
};

seedProducts();
