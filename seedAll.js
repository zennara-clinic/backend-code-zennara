const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Brand = require('./models/Brand');
const Formulation = require('./models/Formulation');
const Coupon = require('./models/Coupon');
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

const seedData = async () => {
  try {
    await connectDB();

    console.log('\n🗑️  Clearing existing data...');
    
    // Clear existing data
    await Brand.deleteMany({});
    await Formulation.deleteMany({});
    await Coupon.deleteMany({});
    
    console.log('✅ Existing data cleared\n');

    // ========== BRANDS ==========
    console.log('📦 Creating Brands...');
    
    const brands = [
      {
        name: 'Zennara Skincare',
        description: 'Premium skincare solutions with natural ingredients for radiant, healthy skin',
        logo: 'https://images.unsplash.com/photo-1556228578-0d85b1a4d571?w=200&h=200&fit=crop',
        website: 'https://zennara.com',
        isActive: true
      },
      {
        name: 'Zennara Pro',
        description: 'Professional-grade treatments and advanced skincare formulations',
        logo: 'https://images.unsplash.com/photo-1599305445671-ac291c95aaa9?w=200&h=200&fit=crop',
        website: 'https://zennarapro.com',
        isActive: true
      },
      {
        name: 'Zennara Hair',
        description: 'Complete hair care solutions for all hair types and concerns',
        logo: 'https://images.unsplash.com/photo-1522338242992-e1a54906a8da?w=200&h=200&fit=crop',
        website: 'https://zennarahair.com',
        isActive: true
      },
      {
        name: 'Derma Essentials',
        description: 'Dermatologist-recommended products for sensitive and problem skin',
        logo: 'https://images.unsplash.com/photo-1556228852-80c3b5d2e0d0?w=200&h=200&fit=crop',
        website: 'https://dermaessentials.com',
        isActive: true
      },
      {
        name: 'Glow Naturals',
        description: 'Organic and natural beauty products for conscious consumers',
        logo: 'https://images.unsplash.com/photo-1571875257727-256c39da42af?w=200&h=200&fit=crop',
        website: 'https://glownaturals.com',
        isActive: true
      },
      {
        name: 'Luxe Beauty',
        description: 'Luxury skincare and cosmetics for premium beauty experience',
        logo: 'https://images.unsplash.com/photo-1596462502278-27bfdc403348?w=200&h=200&fit=crop',
        website: 'https://luxebeauty.com',
        isActive: true
      }
    ];

    const createdBrands = await Brand.insertMany(brands);
    console.log(`✅ Created ${createdBrands.length} brands`);

    // Update product counts for brands
    for (let brand of createdBrands) {
      const count = await Product.countDocuments({ OrgName: brand.name });
      brand.productsCount = count;
      await brand.save();
    }

    // ========== FORMULATIONS ==========
    console.log('\n🧪 Creating Formulations...');
    
    const formulations = [
      {
        name: 'Serum',
        description: 'Concentrated formulations with active ingredients for targeted skin concerns',
        isActive: true
      },
      {
        name: 'Cream',
        description: 'Rich, moisturizing formulations for hydration and nourishment',
        isActive: true
      },
      {
        name: 'Face Wash',
        description: 'Cleansing formulations to remove impurities and refresh skin',
        isActive: true
      },
      {
        name: 'Moisturizer',
        description: 'Hydrating formulations to maintain skin moisture balance',
        isActive: true
      },
      {
        name: 'Sunscreen',
        description: 'Protective formulations with SPF to shield skin from UV damage',
        isActive: true
      },
      {
        name: 'Facial Treatment',
        description: 'Professional-grade treatments for intensive skin care',
        isActive: true
      },
      {
        name: 'Shampoo',
        description: 'Hair cleansing formulations for healthy scalp and hair',
        isActive: true
      },
      {
        name: 'Lipbalm',
        description: 'Nourishing lip care formulations for soft, smooth lips',
        isActive: true
      },
      {
        name: 'Anti Aging',
        description: 'Advanced formulations to reduce signs of aging and promote youthful skin',
        isActive: true
      },
      {
        name: 'Pigmentation',
        description: 'Specialized treatments for dark spots and uneven skin tone',
        isActive: true
      },
      {
        name: 'Hydrafacial Consumable',
        description: 'Professional hydrafacial treatment solutions',
        isActive: true
      },
      {
        name: 'Sachets',
        description: 'Single-use sachets for convenient skincare application',
        isActive: true
      }
    ];

    const createdFormulations = await Formulation.insertMany(formulations);
    console.log(`✅ Created ${createdFormulations.length} formulations`);

    // Update product counts for formulations
    for (let formulation of createdFormulations) {
      const count = await Product.countDocuments({ formulation: formulation.name });
      formulation.productsCount = count;
      await formulation.save();
    }

    // ========== COUPONS ==========
    console.log('\n🎟️  Creating Coupons...');
    
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const nextWeek = new Date(now);
    nextWeek.setDate(nextWeek.getDate() + 7);
    const nextMonth = new Date(now);
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    const lastWeek = new Date(now);
    lastWeek.setDate(lastWeek.getDate() - 7);
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);

    const coupons = [
      {
        code: 'WELCOME10',
        description: 'Welcome offer - 10% off on first purchase',
        discountType: 'percentage',
        discountValue: 10,
        minOrderValue: 500,
        maxDiscount: 200,
        usageLimit: 100,
        usageCount: 15,
        perUserLimit: 1,
        validFrom: now,
        validUntil: nextMonth,
        applicableProducts: [],
        applicableCategories: [],
        isActive: true,
        isPublic: true
      },
      {
        code: 'FLAT500',
        description: 'Flat ₹500 off on orders above ₹2000',
        discountType: 'fixed',
        discountValue: 500,
        minOrderValue: 2000,
        maxDiscount: null,
        usageLimit: 50,
        usageCount: 8,
        perUserLimit: 2,
        validFrom: now,
        validUntil: nextMonth,
        applicableProducts: [],
        applicableCategories: [],
        isActive: true,
        isPublic: true
      },
      {
        code: 'SKINCARE20',
        description: '20% off on all skincare products',
        discountType: 'percentage',
        discountValue: 20,
        minOrderValue: 1000,
        maxDiscount: 500,
        usageLimit: 200,
        usageCount: 45,
        perUserLimit: 3,
        validFrom: now,
        validUntil: nextMonth,
        applicableProducts: [],
        applicableCategories: ['Serum', 'Cream', 'Face Wash'],
        isActive: true,
        isPublic: true
      },
      {
        code: 'SUMMER25',
        description: 'Summer sale - 25% off sitewide',
        discountType: 'percentage',
        discountValue: 25,
        minOrderValue: 1500,
        maxDiscount: 1000,
        usageLimit: null,
        usageCount: 120,
        perUserLimit: null,
        validFrom: now,
        validUntil: nextMonth,
        applicableProducts: [],
        applicableCategories: [],
        isActive: true,
        isPublic: true
      },
      {
        code: 'NEWLAUNCH',
        description: 'New product launch offer - Coming soon!',
        discountType: 'percentage',
        discountValue: 15,
        minOrderValue: 800,
        maxDiscount: 300,
        usageLimit: 100,
        usageCount: 0,
        perUserLimit: 1,
        validFrom: nextWeek,
        validUntil: nextMonth,
        applicableProducts: [],
        applicableCategories: [],
        isActive: true,
        isPublic: true
      },
      {
        code: 'EXPIRED50',
        description: 'Expired coupon - 50% off (for testing)',
        discountType: 'percentage',
        discountValue: 50,
        minOrderValue: 1000,
        maxDiscount: 1500,
        usageLimit: 50,
        usageCount: 50,
        perUserLimit: 1,
        validFrom: lastWeek,
        validUntil: yesterday,
        applicableProducts: [],
        applicableCategories: [],
        isActive: false,
        isPublic: false
      },
      {
        code: 'VIP100',
        description: 'VIP exclusive - ₹100 off',
        discountType: 'fixed',
        discountValue: 100,
        minOrderValue: 500,
        maxDiscount: null,
        usageLimit: 30,
        usageCount: 5,
        perUserLimit: 5,
        validFrom: now,
        validUntil: nextMonth,
        applicableProducts: [],
        applicableCategories: [],
        isActive: true,
        isPublic: false
      },
      {
        code: 'MEGA30',
        description: 'Mega sale - 30% off on premium products',
        discountType: 'percentage',
        discountValue: 30,
        minOrderValue: 2500,
        maxDiscount: 2000,
        usageLimit: 75,
        usageCount: 22,
        perUserLimit: 2,
        validFrom: now,
        validUntil: nextMonth,
        applicableProducts: [],
        applicableCategories: [],
        isActive: true,
        isPublic: true
      }
    ];

    const createdCoupons = await Coupon.insertMany(coupons);
    console.log(`✅ Created ${createdCoupons.length} coupons`);

    // ========== SUMMARY ==========
    console.log('\n🎉 Seeding completed successfully!\n');
    console.log('📊 Summary:');
    console.log(`   - Brands: ${await Brand.countDocuments()}`);
    console.log(`   - Formulations: ${await Formulation.countDocuments()}`);
    console.log(`   - Coupons: ${await Coupon.countDocuments()}`);
    console.log(`   - Products: ${await Product.countDocuments()}`);
    
    console.log('\n✨ Sample Data:');
    console.log(`   - Active Brands: ${await Brand.countDocuments({ isActive: true })}`);
    console.log(`   - Active Formulations: ${await Formulation.countDocuments({ isActive: true })}`);
    console.log(`   - Active Coupons: ${createdCoupons.filter(c => c.isActive && new Date(c.validFrom) <= now && new Date(c.validUntil) >= now).length}`);
    console.log(`   - Expired Coupons: ${createdCoupons.filter(c => new Date(c.validUntil) < now).length}`);
    console.log(`   - Upcoming Coupons: ${createdCoupons.filter(c => new Date(c.validFrom) > now).length}`);

    console.log('\n✅ You can now use the admin panel to manage:');
    console.log('   - Brands at /brands');
    console.log('   - Formulations at /formulations');
    console.log('   - Coupons at /coupons');

    process.exit(0);
  } catch (error) {
    console.error('❌ Error seeding data:', error);
    process.exit(1);
  }
};

seedData();
