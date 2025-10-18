const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Inventory = require('../models/Inventory');

dotenv.config();

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ MongoDB connected for inventory seeding');
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    process.exit(1);
  }
};

const inventoryItems = [
  {
    inventoryName: 'Acglicolic Liposomal Serum 30Ml',
    inventoryCategory: 'Retail products',
    code: 'AGL-30',
    formulation: 'Serum',
    orgName: 'Zennara Clinic - Jubliee Hills',
    batchMaintenance: 'Batchable',
    batchType: 'ByExpiry',
    batchNo: '25048402',
    batchExpiryDate: new Date('2026-02-28'),
    qohBatchWise: 8,
    qohAllBatches: 8,
    batchTaxName: 'GST-18%',
    batchBuyingPrice: 1518.64,
    batchAfterTaxBuyingPrice: 1791.995,
    batchSellingPrice: 2372.88,
    batchAfterTaxSellingPrice: 2799.998,
    inventoryTax: 'GST-18%',
    inventoryBuyingPrice: 1518.64,
    inventoryAfterTaxBuyingPrice: 1791.995,
    inventorySellingPrice: 2372.881,
    inventoryAfterTaxSellingPrice: 2800,
    vendorName: 'Super Drug Company',
    reOrderLevel: 5,
    targetLevel: 20,
    packName: '',
    packSize: 1,
    hasGenerics: 'No',
    hasProtocol: 'No',
    commissionRate: '0.00'
  },
  {
    inventoryName: 'Active 4 Skin Solution 237Ml',
    inventoryCategory: 'Consumables',
    code: 'ACT-237',
    formulation: 'Hydrafacial Consumable',
    orgName: 'Zennara Clinic - Jubliee Hills',
    batchMaintenance: 'Non Batchable',
    batchType: 'FIFO',
    batchNo: '',
    batchExpiryDate: null,
    qohBatchWise: 0,
    qohAllBatches: 15,
    batchTaxName: 'GST-18%',
    batchBuyingPrice: 0,
    batchAfterTaxBuyingPrice: 0,
    batchSellingPrice: 0,
    batchAfterTaxSellingPrice: 0,
    inventoryTax: 'GST-18%',
    inventoryBuyingPrice: 25,
    inventoryAfterTaxBuyingPrice: 29.5,
    inventorySellingPrice: 35,
    inventoryAfterTaxSellingPrice: 41.3,
    vendorName: 'Spectra Medical',
    reOrderLevel: 10,
    targetLevel: 30,
    packName: '',
    packSize: 1,
    hasGenerics: 'No',
    hasProtocol: 'No',
    commissionRate: '0.00'
  },
  {
    inventoryName: 'Advanced Balancing Day Cream',
    inventoryCategory: 'Retail products',
    code: 'ABD-50',
    formulation: 'Cream',
    orgName: 'Zennara Clinic - Jubliee Hills',
    batchMaintenance: 'Batchable',
    batchType: 'FIFO',
    batchNo: 'IBC2501',
    batchExpiryDate: new Date('2025-05-28'),
    qohBatchWise: 9,
    qohAllBatches: 9,
    batchTaxName: 'GST-18%',
    batchBuyingPrice: 2058.114,
    batchAfterTaxBuyingPrice: 2428.575,
    batchSellingPrice: 3389.83,
    batchAfterTaxSellingPrice: 3999.999,
    inventoryTax: 'GST-18%',
    inventoryBuyingPrice: 2058.114,
    inventoryAfterTaxBuyingPrice: 2428.575,
    inventorySellingPrice: 3389.831,
    inventoryAfterTaxSellingPrice: 4000.001,
    vendorName: 'EROTAS ASSOCIATES',
    reOrderLevel: 5,
    targetLevel: 15,
    packName: '',
    packSize: 1,
    hasGenerics: 'No',
    hasProtocol: 'No',
    commissionRate: '0.00'
  },
  {
    inventoryName: 'Age Element Brightening Booster',
    inventoryCategory: 'Consumables',
    code: 'AEB-100',
    formulation: 'Facial Treatment',
    orgName: 'Zennara Clinic - Jubliee Hills',
    batchMaintenance: 'Batchable',
    batchType: 'FIFO',
    batchNo: '13912',
    batchExpiryDate: new Date('2026-04-29'),
    qohBatchWise: 1,
    qohAllBatches: 1,
    batchTaxName: 'GST-18%',
    batchBuyingPrice: 6991.52,
    batchAfterTaxBuyingPrice: 8249.994,
    batchSellingPrice: 6991.52,
    batchAfterTaxSellingPrice: 8249.994,
    inventoryTax: 'GST-18%',
    inventoryBuyingPrice: 6991.52,
    inventoryAfterTaxBuyingPrice: 8249.994,
    inventorySellingPrice: 6991.52,
    inventoryAfterTaxSellingPrice: 8249.994,
    vendorName: 'Spectra Medical',
    reOrderLevel: 2,
    targetLevel: 5,
    packName: '',
    packSize: 1,
    hasGenerics: 'No',
    hasProtocol: 'No',
    commissionRate: '0.00'
  },
  {
    inventoryName: 'Ahaglow Face Wash Gel',
    inventoryCategory: 'Retail products',
    code: 'AFW-100',
    formulation: 'Face Wash',
    orgName: 'Zennara Clinic - Jubliee Hills',
    batchMaintenance: 'Batchable',
    batchType: 'FIFO',
    batchNo: 'UFT9M068',
    batchExpiryDate: new Date('2027-03-27'),
    qohBatchWise: 10,
    qohAllBatches: 10,
    batchTaxName: 'GST-18%',
    batchBuyingPrice: 383.05,
    batchAfterTaxBuyingPrice: 451.999,
    batchSellingPrice: 478.81,
    batchAfterTaxSellingPrice: 564.996,
    inventoryTax: 'GST-18%',
    inventoryBuyingPrice: 383.05,
    inventoryAfterTaxBuyingPrice: 451.999,
    inventorySellingPrice: 478.814,
    inventoryAfterTaxSellingPrice: 565.001,
    vendorName: 'Venkata sai Agencies Drugs Private Limited',
    reOrderLevel: 10,
    targetLevel: 25,
    packName: '',
    packSize: 1,
    hasGenerics: 'No',
    hasProtocol: 'No',
    commissionRate: '0.00'
  },
  {
    inventoryName: 'Hydrating Moisturizer SPF 30',
    inventoryCategory: 'Retail products',
    code: 'HM-SPF30',
    formulation: 'Moisturizer',
    orgName: 'Zennara Clinic - Jubliee Hills',
    batchMaintenance: 'Batchable',
    batchType: 'ByExpiry',
    batchNo: 'HM2024001',
    batchExpiryDate: new Date('2026-12-31'),
    qohBatchWise: 25,
    qohAllBatches: 25,
    batchTaxName: 'GST-18%',
    batchBuyingPrice: 850,
    batchAfterTaxBuyingPrice: 1003,
    batchSellingPrice: 1200,
    batchAfterTaxSellingPrice: 1416,
    inventoryTax: 'GST-18%',
    inventoryBuyingPrice: 850,
    inventoryAfterTaxBuyingPrice: 1003,
    inventorySellingPrice: 1200,
    inventoryAfterTaxSellingPrice: 1416,
    vendorName: 'Super Drug Company',
    reOrderLevel: 15,
    targetLevel: 40,
    packName: '',
    packSize: 1,
    hasGenerics: 'No',
    hasProtocol: 'No',
    commissionRate: '5.00'
  },
  {
    inventoryName: 'Vitamin C Serum 15%',
    inventoryCategory: 'Retail products',
    code: 'VCS-15',
    formulation: 'Serum',
    orgName: 'Zennara Clinic - Jubliee Hills',
    batchMaintenance: 'Batchable',
    batchType: 'ByExpiry',
    batchNo: 'VCS2024002',
    batchExpiryDate: new Date('2025-08-15'),
    qohBatchWise: 3,
    qohAllBatches: 3,
    batchTaxName: 'GST-18%',
    batchBuyingPrice: 1250,
    batchAfterTaxBuyingPrice: 1475,
    batchSellingPrice: 1800,
    batchAfterTaxSellingPrice: 2124,
    inventoryTax: 'GST-18%',
    inventoryBuyingPrice: 1250,
    inventoryAfterTaxBuyingPrice: 1475,
    inventorySellingPrice: 1800,
    inventoryAfterTaxSellingPrice: 2124,
    vendorName: 'EROTAS ASSOCIATES',
    reOrderLevel: 5,
    targetLevel: 15,
    packName: '',
    packSize: 1,
    hasGenerics: 'No',
    hasProtocol: 'No',
    commissionRate: '10.00'
  },
  {
    inventoryName: 'Collagen Booster Ampoules',
    inventoryCategory: 'Consumables',
    code: 'CBA-10',
    formulation: 'Injection',
    orgName: 'Zennara Clinic - Jubliee Hills',
    batchMaintenance: 'Batchable',
    batchType: 'ByExpiry',
    batchNo: 'CB2024003',
    batchExpiryDate: new Date('2025-11-30'),
    qohBatchWise: 0,
    qohAllBatches: 0,
    batchTaxName: 'GST-12%',
    batchBuyingPrice: 5000,
    batchAfterTaxBuyingPrice: 5600,
    batchSellingPrice: 7500,
    batchAfterTaxSellingPrice: 8400,
    inventoryTax: 'GST-12%',
    inventoryBuyingPrice: 5000,
    inventoryAfterTaxBuyingPrice: 5600,
    inventorySellingPrice: 7500,
    inventoryAfterTaxSellingPrice: 8400,
    vendorName: 'Spectra Medical',
    reOrderLevel: 3,
    targetLevel: 10,
    packName: 'Box of 10',
    packSize: 10,
    hasGenerics: 'Yes',
    hasProtocol: 'Yes',
    commissionRate: '15.00'
  }
];

const seedInventory = async () => {
  try {
    await connectDB();

    // Clear existing inventory
    await Inventory.deleteMany();
    console.log('🗑️  Cleared existing inventory items');

    // Insert new inventory
    const createdInventory = await Inventory.insertMany(inventoryItems);
    console.log(`✅ Successfully seeded ${createdInventory.length} inventory items`);

    // Display summary
    console.log('\n📊 Inventory Summary:');
    console.log(`   Total Items: ${createdInventory.length}`);
    console.log(`   Batchable: ${createdInventory.filter(i => i.batchMaintenance === 'Batchable').length}`);
    console.log(`   Non-Batchable: ${createdInventory.filter(i => i.batchMaintenance === 'Non Batchable').length}`);
    console.log(`   Low Stock: ${createdInventory.filter(i => i.qohAllBatches < 10 && i.qohAllBatches > 0).length}`);
    console.log(`   Out of Stock: ${createdInventory.filter(i => i.qohAllBatches === 0).length}`);

    process.exit(0);
  } catch (error) {
    console.error('❌ Error seeding inventory:', error);
    process.exit(1);
  }
};

seedInventory();
