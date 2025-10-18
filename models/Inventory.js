const mongoose = require('mongoose');

const inventorySchema = new mongoose.Schema({
  // Basic Information
  inventoryName: {
    type: String,
    trim: true
  },
  inventoryCategory: {
    type: String,
    enum: ['Retail products', 'Consumables'],
    default: 'Retail products'
  },
  code: {
    type: String,
    trim: true
  },
  formulation: {
    type: String
  },
  orgName: {
    type: String
  },

  // Batch Information
  batchMaintenance: {
    type: String,
    enum: ['Batchable', 'Non Batchable'],
    default: 'Non Batchable'
  },
  batchType: {
    type: String,
    enum: ['FIFO', 'ByExpiry'],
    default: 'FIFO'
  },
  batchNo: {
    type: String,
    trim: true
  },
  batchExpiryDate: {
    type: Date
  },

  // Stock Information
  qohBatchWise: {
    type: Number,
    default: 0,
    min: 0
  },
  qohAllBatches: {
    type: Number,
    default: 0,
    min: 0
  },
  reOrderLevel: {
    type: Number,
    default: 0,
    min: 0
  },
  targetLevel: {
    type: Number,
    default: 0,
    min: 0
  },

  // Batch Pricing
  batchTaxName: {
    type: String,
    default: 'GST-18%'
  },
  batchBuyingPrice: {
    type: Number,
    default: 0,
    min: 0
  },
  batchAfterTaxBuyingPrice: {
    type: Number,
    default: 0,
    min: 0
  },
  batchSellingPrice: {
    type: Number,
    default: 0,
    min: 0
  },
  batchAfterTaxSellingPrice: {
    type: Number,
    default: 0,
    min: 0
  },

  // Inventory Pricing
  gstPercentage: {
    type: Number,
    default: 18,
    min: 0,
    max: 100
  },
  inventoryTax: {
    type: String,
    default: 'GST-18%'
  },
  inventoryBuyingPrice: {
    type: Number,
    default: 0,
    min: 0
  },
  inventoryAfterTaxBuyingPrice: {
    type: Number,
    default: 0,
    min: 0
  },
  inventorySellingPrice: {
    type: Number,
    default: 0,
    min: 0
  },
  inventoryAfterTaxSellingPrice: {
    type: Number,
    default: 0,
    min: 0
  },

  // Additional Details
  vendorName: {
    type: String
  },
  packName: {
    type: String,
    trim: true
  },
  packSize: {
    type: Number,
    default: 1,
    min: 1
  },
  hasGenerics: {
    type: String,
    enum: ['Yes', 'No'],
    default: 'No'
  },
  hasProtocol: {
    type: String,
    enum: ['Yes', 'No'],
    default: 'No'
  },
  commissionRate: {
    type: String,
    default: '0.00'
  }
}, {
  timestamps: true
});

// Indexes for better query performance
inventorySchema.index({ inventoryName: 1 });
inventorySchema.index({ inventoryCategory: 1 });
inventorySchema.index({ formulation: 1 });
inventorySchema.index({ batchMaintenance: 1 });
inventorySchema.index({ vendorName: 1 });
inventorySchema.index({ qohAllBatches: 1 });

// Virtual for stock status
inventorySchema.virtual('stockStatus').get(function() {
  if (this.qohAllBatches === 0) return 'Out of Stock';
  if (this.qohAllBatches < 10) return 'Low Stock';
  return 'In Stock';
});

// Virtual for expiry status
inventorySchema.virtual('expiryStatus').get(function() {
  if (!this.batchExpiryDate) return 'N/A';
  const today = new Date();
  const expiry = new Date(this.batchExpiryDate);
  const daysUntilExpiry = Math.floor((expiry - today) / (1000 * 60 * 60 * 24));
  
  if (daysUntilExpiry < 0) return 'Expired';
  if (daysUntilExpiry < 90) return 'Expiring Soon';
  return 'Valid';
});

// Ensure virtuals are included when converting to JSON
inventorySchema.set('toJSON', { virtuals: true });
inventorySchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Inventory', inventorySchema);
