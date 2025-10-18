const mongoose = require('mongoose');
const Coupon = require('../models/Coupon');
require('dotenv').config();

const coupons = [
  {
    code: 'WELCOME10',
    description: 'Get 10% off on your first order. Valid on orders above ₹500',
    discountType: 'percentage',
    discountValue: 10,
    minOrderValue: 500,
    maxDiscount: 200,
    usageLimit: 1000,
    validFrom: new Date(),
    validUntil: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // 90 days from now
    isActive: true,
    isPublic: true
  },
  {
    code: 'SKINCARE15',
    description: 'Exclusive 15% off on all skincare products. No minimum order value',
    discountType: 'percentage',
    discountValue: 15,
    minOrderValue: 0,
    maxDiscount: 500,
    usageLimit: 500,
    validFrom: new Date(),
    validUntil: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000), // 60 days from now
    isActive: true,
    isPublic: true
  },
  {
    code: 'FLAT100',
    description: 'Flat ₹100 off on orders above ₹1000',
    discountType: 'fixed',
    discountValue: 100,
    minOrderValue: 1000,
    maxDiscount: null,
    usageLimit: 2000,
    validFrom: new Date(),
    validUntil: new Date(Date.now() + 45 * 24 * 60 * 60 * 1000), // 45 days from now
    isActive: true,
    isPublic: true
  },
  {
    code: 'ZENNARA20',
    description: 'Special offer! Get 20% off on all Zennara products. Minimum order ₹750',
    discountType: 'percentage',
    discountValue: 20,
    minOrderValue: 750,
    maxDiscount: 300,
    usageLimit: 750,
    validFrom: new Date(),
    validUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
    isActive: true,
    isPublic: true
  },
  {
    code: 'MEGA50',
    description: 'Mega sale! Save ₹50 on orders above ₹500',
    discountType: 'fixed',
    discountValue: 50,
    minOrderValue: 500,
    maxDiscount: null,
    usageLimit: 1500,
    validFrom: new Date(),
    validUntil: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000), // 60 days from now
    isActive: true,
    isPublic: true
  },
  {
    code: 'VIP25',
    description: 'VIP exclusive! 25% off on your entire purchase. Minimum order ₹1500',
    discountType: 'percentage',
    discountValue: 25,
    minOrderValue: 1500,
    maxDiscount: 1000,
    usageLimit: 300,
    validFrom: new Date(),
    validUntil: new Date(Date.now() + 120 * 24 * 60 * 60 * 1000), // 120 days from now
    isActive: true,
    isPublic: true
  },
  {
    code: 'FLAT200',
    description: 'Super saver! Flat ₹200 off on orders above ₹2000',
    discountType: 'fixed',
    discountValue: 200,
    minOrderValue: 2000,
    maxDiscount: null,
    usageLimit: 500,
    validFrom: new Date(),
    validUntil: new Date(Date.now() + 75 * 24 * 60 * 60 * 1000), // 75 days from now
    isActive: true,
    isPublic: true
  },
  {
    code: 'SUMMER12',
    description: 'Summer special! 12% off on all products with no minimum order',
    discountType: 'percentage',
    discountValue: 12,
    minOrderValue: 0,
    maxDiscount: 250,
    usageLimit: 1000,
    validFrom: new Date(),
    validUntil: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // 90 days from now
    isActive: true,
    isPublic: true
  }
];

async function seedCoupons() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ MongoDB Connected');

    // Clear existing coupons
    await Coupon.deleteMany({});
    console.log('🗑️  Cleared existing coupons');

    // Insert sample coupons
    const createdCoupons = await Coupon.insertMany(coupons);
    console.log(`✅ Successfully seeded ${createdCoupons.length} coupons`);

    // Display created coupons
    console.log('\n📋 Created Coupons:');
    createdCoupons.forEach((coupon, index) => {
      console.log(`\n${index + 1}. ${coupon.code}`);
      console.log(`   Description: ${coupon.description}`);
      console.log(`   Type: ${coupon.discountType}`);
      console.log(`   Value: ${coupon.discountType === 'percentage' ? coupon.discountValue + '%' : '₹' + coupon.discountValue}`);
      console.log(`   Min Order: ₹${coupon.minOrderValue}`);
      console.log(`   Max Discount: ${coupon.maxDiscount ? '₹' + coupon.maxDiscount : 'Unlimited'}`);
      console.log(`   Usage Limit: ${coupon.usageLimit}`);
      console.log(`   Valid Until: ${coupon.validUntil.toLocaleDateString()}`);
    });

    console.log('\n✨ Coupon seeding completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error seeding coupons:', error);
    process.exit(1);
  }
}

// Run the seeder
seedCoupons();
