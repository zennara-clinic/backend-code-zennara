const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Product = require('./models/Product');
const connectDB = require('./config/db');

dotenv.config();

const products = [
  {
    name: 'Hydrating Hyaluronic Serum',
    description: 'Advanced hydrating serum with pure hyaluronic acid to deeply moisturize and plump your skin for a youthful, dewy glow.',
    formulation: 'Serum',
    OrgName: 'Zennara Glow',
    price: 1299,
    gstPercentage: 18,
    image: 'https://images.unsplash.com/photo-1620916566398-39f1143ab7be?w=800&h=800&fit=crop&q=80',
    stock: 45,
    rating: 0,
    reviews: 0,
    isActive: true,
    isPopular: true
  },
  {
    name: 'Vitamin C Brightening Face Wash',
    description: 'Gentle yet effective face wash enriched with vitamin C to brighten skin, remove impurities, and reveal a radiant complexion.',
    formulation: 'Face Wash',
    OrgName: 'Zennara Pure',
    price: 599,
    gstPercentage: 18,
    image: 'https://images.unsplash.com/photo-1556228578-dd6a04c70494?w=800&h=800&fit=crop&q=80',
    stock: 60,
    rating: 0,
    reviews: 0,
    isActive: true,
    isPopular: true
  },
  {
    name: 'Anti-Aging Retinol Cream',
    description: 'Powerful anti-aging cream with retinol to reduce fine lines, wrinkles, and boost collagen production for firmer, younger-looking skin.',
    formulation: 'Anti Aging',
    OrgName: 'Zennara Youth',
    price: 1599,
    gstPercentage: 18,
    image: 'https://images.unsplash.com/photo-1570554886111-e80fcca6a029?w=800&h=800&fit=crop&q=80',
    stock: 35,
    rating: 0,
    reviews: 0,
    isActive: true,
    isPopular: true
  },
  {
    name: 'Daily Defense Sunscreen SPF 50+',
    description: 'Broad-spectrum sunscreen with SPF 50+ to protect your skin from harmful UVA/UVB rays while providing long-lasting hydration.',
    formulation: 'Sunscreen',
    OrgName: 'Zennara Shield',
    price: 899,
    gstPercentage: 18,
    image: 'https://images.unsplash.com/photo-1556228720-195a672e8a03?w=800&h=800&fit=crop&q=80',
    stock: 80,
    rating: 0,
    reviews: 0,
    isActive: true,
    isPopular: false
  },
  {
    name: 'Nourishing Hair Shampoo',
    description: 'Sulfate-free shampoo enriched with natural oils to cleanse, nourish, and strengthen hair from root to tip for silky smooth locks.',
    formulation: 'Shampoo',
    OrgName: 'Zennara Hair',
    price: 549,
    gstPercentage: 18,
    image: 'https://images.unsplash.com/photo-1535585209827-a15fcdbc4c2d?w=800&h=800&fit=crop&q=80',
    stock: 70,
    rating: 0,
    reviews: 0,
    isActive: true,
    isPopular: false
  },
  {
    name: 'Intensive Hydration Moisturizer',
    description: 'Rich, non-greasy moisturizer with ceramides and peptides to lock in moisture and repair skin barrier for all-day hydration.',
    formulation: 'Moisturizer',
    OrgName: 'Zennara Hydra',
    price: 1099,
    gstPercentage: 18,
    image: 'https://images.unsplash.com/photo-1556228994-330a5b87e4b9?w=800&h=800&fit=crop&q=80',
    stock: 50,
    rating: 0,
    reviews: 0,
    isActive: true,
    isPopular: false
  },
  {
    name: 'Rejuvenating Facial Treatment',
    description: 'Professional-grade facial treatment combining multiple active ingredients to rejuvenate, brighten, and restore youthful radiance to your skin.',
    formulation: 'Facial Treatment',
    OrgName: 'Zennara Pro',
    price: 2299,
    gstPercentage: 18,
    image: 'https://images.unsplash.com/photo-1608248597279-f99d160bfcbc?w=800&h=800&fit=crop&q=80',
    stock: 25,
    rating: 0,
    reviews: 0,
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
