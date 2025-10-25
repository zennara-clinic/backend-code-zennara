const Inventory = require('../models/Inventory');
const Product = require('../models/Product');
const ProductOrder = require('../models/ProductOrder');
const Vendor = require('../models/Vendor');

// ========================================
// INVENTORY & PRODUCT INSIGHTS
// ========================================

// Get Comprehensive Inventory Analytics
exports.getInventoryAnalytics = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    // Default to last 30 days for order analysis
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();
    
    // Get all inventory items
    const inventoryItems = await Inventory.find();
    
    // Get all products for reference
    const products = await Product.find();
    
    // Get product orders in date range for sales analysis
    const productOrders = await ProductOrder.find({
      createdAt: { $gte: start, $lte: end },
      orderStatus: { $nin: ['Cancelled', 'Returned'] }
    });
    
    // Get all vendors
    const vendors = await Vendor.find({ status: 'Active' });

    // ============================================
    // 1. LOW STOCK ALERTS (Critical items)
    // ============================================
    const lowStockItems = inventoryItems
      .filter(item => {
        const reorderLevel = item.reOrderLevel || 10;
        const currentStock = item.qohAllBatches || 0;
        // Critical if below 20% of reorder level and above 0
        return currentStock > 0 && currentStock <= reorderLevel * 0.2;
      })
      .map(item => ({
        id: item._id,
        inventoryName: item.inventoryName,
        formulation: item.formulation,
        orgName: item.orgName,
        currentStock: item.qohAllBatches,
        reorderLevel: item.reOrderLevel,
        targetLevel: item.targetLevel,
        shortage: item.reOrderLevel - item.qohAllBatches,
        severity: item.qohAllBatches === 0 ? 'CRITICAL' : 'WARNING',
        batchNo: item.batchNo,
        vendorName: item.vendorName
      }))
      .sort((a, b) => a.currentStock - b.currentStock)
      .slice(0, 15);

    // ============================================
    // 2. OUT OF STOCK ITEMS COUNT
    // ============================================
    const outOfStockItems = inventoryItems
      .filter(item => item.qohAllBatches === 0)
      .map(item => ({
        id: item._id,
        inventoryName: item.inventoryName,
        formulation: item.formulation,
        orgName: item.orgName,
        category: item.inventoryCategory,
        reorderLevel: item.reOrderLevel,
        lastBatchNo: item.batchNo,
        vendorName: item.vendorName,
        daysOutOfStock: item.updatedAt ? Math.floor((new Date() - item.updatedAt) / (1000 * 60 * 60 * 24)) : 0
      }))
      .slice(0, 20);
    
    const outOfStockCount = outOfStockItems.length;

    // ============================================
    // 3. FAST-MOVING PRODUCTS (Top sellers)
    // ============================================
    // Calculate units sold from product orders
    const productSalesMap = {};
    productOrders.forEach(order => {
      order.items.forEach(item => {
        const productId = item.productId.toString();
        if (!productSalesMap[productId]) {
          productSalesMap[productId] = {
            productId,
            productName: item.productName,
            totalQuantity: 0,
            totalRevenue: 0,
            orderCount: 0
          };
        }
        productSalesMap[productId].totalQuantity += item.quantity;
        productSalesMap[productId].totalRevenue += item.subtotal;
        productSalesMap[productId].orderCount += 1;
      });
    });
    
    const fastMovingProducts = Object.values(productSalesMap)
      .map(product => {
        // Find corresponding inventory item
        const invItem = inventoryItems.find(inv => 
          inv.inventoryName && product.productName && 
          inv.inventoryName.toLowerCase().includes(product.productName.toLowerCase())
        );
        
        return {
          id: product.productId,
          productName: product.productName,
          unitsSold: product.totalQuantity,
          revenue: Math.round(product.totalRevenue),
          orderCount: product.orderCount,
          currentStock: invItem ? invItem.qohAllBatches : 0,
          turnoverRate: invItem && invItem.qohAllBatches > 0 
            ? (product.totalQuantity / invItem.qohAllBatches * 100).toFixed(1)
            : 'N/A',
          avgOrderValue: Math.round(product.totalRevenue / product.orderCount)
        };
      })
      .sort((a, b) => b.unitsSold - a.unitsSold)
      .slice(0, 10);

    // ============================================
    // 4. SLOW-MOVING INVENTORY (Dead stock)
    // ============================================
    const soldProductIds = Object.keys(productSalesMap);
    const slowMovingInventory = inventoryItems
      .filter(item => {
        // Has stock but low/no sales
        const hasStock = item.qohAllBatches > 0;
        const productInSales = soldProductIds.some(id => {
          const soldProduct = productSalesMap[id];
          return item.inventoryName && soldProduct.productName &&
                 item.inventoryName.toLowerCase().includes(soldProduct.productName.toLowerCase());
        });
        
        return hasStock && !productInSales;
      })
      .map(item => {
        const value = item.qohAllBatches * (item.inventoryAfterTaxSellingPrice || 0);
        const daysInStock = item.createdAt 
          ? Math.floor((new Date() - item.createdAt) / (1000 * 60 * 60 * 24))
          : 0;
        
        return {
          id: item._id,
          inventoryName: item.inventoryName,
          formulation: item.formulation,
          orgName: item.orgName,
          quantity: item.qohAllBatches,
          value: Math.round(value),
          daysInStock,
          batchNo: item.batchNo,
          expiryDate: item.batchExpiryDate,
          recommendation: daysInStock > 180 ? 'Consider discount or bundle' : 'Monitor closely'
        };
      })
      .sort((a, b) => b.daysInStock - a.daysInStock)
      .slice(0, 15);

    // ============================================
    // 5. INVENTORY VALUE (Total stock worth)
    // ============================================
    const totalInventoryValue = inventoryItems.reduce((sum, item) => {
      return sum + (item.qohAllBatches * (item.inventoryAfterTaxSellingPrice || 0));
    }, 0);
    
    const totalInventoryCost = inventoryItems.reduce((sum, item) => {
      return sum + (item.qohAllBatches * (item.inventoryAfterTaxBuyingPrice || 0));
    }, 0);
    
    const potentialProfit = totalInventoryValue - totalInventoryCost;

    // Inventory value by formulation
    const inventoryValueByFormulation = {};
    inventoryItems.forEach(item => {
      const formulation = item.formulation || 'Uncategorized';
      const value = item.qohAllBatches * (item.inventoryAfterTaxSellingPrice || 0);
      
      if (!inventoryValueByFormulation[formulation]) {
        inventoryValueByFormulation[formulation] = {
          value: 0,
          units: 0,
          items: 0
        };
      }
      inventoryValueByFormulation[formulation].value += value;
      inventoryValueByFormulation[formulation].units += item.qohAllBatches;
      inventoryValueByFormulation[formulation].items += 1;
    });
    
    // Inventory value by category
    const inventoryValueByCategory = {};
    inventoryItems.forEach(item => {
      const category = item.inventoryCategory || 'Other';
      const value = item.qohAllBatches * (item.inventoryAfterTaxSellingPrice || 0);
      
      if (!inventoryValueByCategory[category]) {
        inventoryValueByCategory[category] = 0;
      }
      inventoryValueByCategory[category] += value;
    });

    // ============================================
    // 6. PRODUCT EXPIRY ALERTS
    // ============================================
    const now = new Date();
    const thirtyDays = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const sixtyDays = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);
    const ninetyDays = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

    const expiringItems = inventoryItems.filter(item => 
      item.batchExpiryDate && item.qohAllBatches > 0
    );
    
    const expiring30Days = expiringItems
      .filter(item => {
        const expiryDate = new Date(item.batchExpiryDate);
        return expiryDate >= now && expiryDate <= thirtyDays;
      })
      .map(item => {
        const daysUntilExpiry = Math.ceil((new Date(item.batchExpiryDate) - now) / (1000 * 60 * 60 * 24));
        const value = item.qohAllBatches * (item.inventoryAfterTaxSellingPrice || 0);
        
        return {
          id: item._id,
          inventoryName: item.inventoryName,
          formulation: item.formulation,
          batchNo: item.batchNo,
          quantity: item.qohAllBatches,
          expiryDate: item.batchExpiryDate,
          daysUntilExpiry,
          value: Math.round(value),
          severity: daysUntilExpiry <= 7 ? 'CRITICAL' : daysUntilExpiry <= 15 ? 'HIGH' : 'MEDIUM',
          action: daysUntilExpiry <= 7 ? 'Immediate discount' : 'Plan promotion'
        };
      })
      .sort((a, b) => a.daysUntilExpiry - b.daysUntilExpiry);
    
    const expiring60Days = expiringItems.filter(item => {
      const expiryDate = new Date(item.batchExpiryDate);
      return expiryDate > thirtyDays && expiryDate <= sixtyDays;
    }).length;
    
    const expiring90Days = expiringItems.filter(item => {
      const expiryDate = new Date(item.batchExpiryDate);
      return expiryDate > sixtyDays && expiryDate <= ninetyDays;
    }).length;
    
    const expired = expiringItems.filter(item => {
      const expiryDate = new Date(item.batchExpiryDate);
      return expiryDate < now;
    }).length;

    // ============================================
    // 7. REORDER POINT STATUS
    // ============================================
    const itemsNeedingReorder = inventoryItems
      .filter(item => {
        const currentStock = item.qohAllBatches || 0;
        const reorderLevel = item.reOrderLevel || 10;
        return currentStock > 0 && currentStock <= reorderLevel;
      })
      .map(item => {
        const shortage = item.targetLevel - item.qohAllBatches;
        const urgency = item.qohAllBatches <= (item.reOrderLevel * 0.5) ? 'URGENT' : 'NORMAL';
        
        return {
          id: item._id,
          inventoryName: item.inventoryName,
          formulation: item.formulation,
          orgName: item.orgName,
          currentStock: item.qohAllBatches,
          reorderLevel: item.reOrderLevel,
          targetLevel: item.targetLevel,
          shortage,
          urgency,
          vendorName: item.vendorName,
          estimatedCost: shortage * (item.inventoryAfterTaxBuyingPrice || 0),
          batchNo: item.batchNo
        };
      })
      .sort((a, b) => {
        // Sort by urgency first, then by shortage
        if (a.urgency === 'URGENT' && b.urgency !== 'URGENT') return -1;
        if (a.urgency !== 'URGENT' && b.urgency === 'URGENT') return 1;
        return b.shortage - a.shortage;
      });

    // ============================================
    // 8. VENDOR PERFORMANCE
    // ============================================
    // Group inventory by vendor
    const vendorStats = {};
    inventoryItems.forEach(item => {
      const vendorName = item.vendorName || 'Unknown';
      if (!vendorStats[vendorName]) {
        vendorStats[vendorName] = {
          vendorName,
          totalItems: 0,
          totalValue: 0,
          lowStockItems: 0,
          outOfStockItems: 0,
          expiringItems: 0
        };
      }
      
      vendorStats[vendorName].totalItems += 1;
      vendorStats[vendorName].totalValue += item.qohAllBatches * (item.inventoryAfterTaxSellingPrice || 0);
      
      if (item.qohAllBatches === 0) {
        vendorStats[vendorName].outOfStockItems += 1;
      } else if (item.qohAllBatches <= (item.reOrderLevel * 0.2)) {
        vendorStats[vendorName].lowStockItems += 1;
      }
      
      if (item.batchExpiryDate && new Date(item.batchExpiryDate) <= thirtyDays) {
        vendorStats[vendorName].expiringItems += 1;
      }
    });
    
    // Merge with vendor data if available
    const vendorPerformance = vendors.map(vendor => {
      const stats = vendorStats[vendor.name] || {
        totalItems: 0,
        totalValue: 0,
        lowStockItems: 0,
        outOfStockItems: 0,
        expiringItems: 0
      };
      
      return {
        vendorId: vendor._id,
        vendorName: vendor.name,
        contactPerson: vendor.contactPerson,
        rating: vendor.rating || 0,
        status: vendor.status,
        itemsSupplied: stats.totalItems,
        inventoryValue: Math.round(stats.totalValue),
        lowStockItems: stats.lowStockItems,
        outOfStockItems: stats.outOfStockItems,
        expiringItems: stats.expiringItems,
        reliabilityScore: stats.totalItems > 0 
          ? Math.round(((stats.totalItems - stats.outOfStockItems) / stats.totalItems) * 100)
          : 0
      };
    }).sort((a, b) => b.inventoryValue - a.inventoryValue);

    // ============================================
    // 9. PRODUCT-WISE PROFIT MARGIN
    // ============================================
    const productProfitMargins = inventoryItems
      .filter(item => item.qohAllBatches > 0 && item.inventoryAfterTaxSellingPrice > 0)
      .map(item => {
        const buyingPrice = item.inventoryAfterTaxBuyingPrice || 0;
        const sellingPrice = item.inventoryAfterTaxSellingPrice || 0;
        const profit = sellingPrice - buyingPrice;
        const margin = sellingPrice > 0 ? ((profit / sellingPrice) * 100).toFixed(2) : 0;
        const totalProfit = profit * item.qohAllBatches;
        
        return {
          id: item._id,
          inventoryName: item.inventoryName,
          formulation: item.formulation,
          orgName: item.orgName,
          buyingPrice: Math.round(buyingPrice),
          sellingPrice: Math.round(sellingPrice),
          profitPerUnit: Math.round(profit),
          marginPercentage: parseFloat(margin),
          quantity: item.qohAllBatches,
          totalPotentialProfit: Math.round(totalProfit),
          category: margin > 50 ? 'High Margin' : margin > 30 ? 'Good Margin' : 'Low Margin'
        };
      })
      .sort((a, b) => b.marginPercentage - a.marginPercentage)
      .slice(0, 15);

    // ============================================
    // 10. INVENTORY TURNOVER RATIO
    // ============================================
    // Calculate COGS from orders in the period
    const cogs = productOrders.reduce((sum, order) => {
      return sum + order.items.reduce((itemSum, item) => {
        // Find inventory item to get buying price
        const invItem = inventoryItems.find(inv => 
          inv.inventoryName && item.productName &&
          inv.inventoryName.toLowerCase().includes(item.productName.toLowerCase())
        );
        const buyingPrice = invItem ? (invItem.inventoryAfterTaxBuyingPrice || 0) : 0;
        return itemSum + (buyingPrice * item.quantity);
      }, 0);
    }, 0);
    
    const avgInventoryCost = totalInventoryCost;
    const inventoryTurnoverRatio = avgInventoryCost > 0 
      ? (cogs / avgInventoryCost).toFixed(2) 
      : 0;
    
    // Days inventory outstanding (DIO)
    const daysInPeriod = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
    const daysInventoryOutstanding = inventoryTurnoverRatio > 0
      ? Math.round(daysInPeriod / inventoryTurnoverRatio)
      : 0;

    // ============================================
    // RESPONSE
    // ============================================
    res.status(200).json({
      success: true,
      data: {
        summary: {
          totalItems: inventoryItems.length,
          totalValue: Math.round(totalInventoryValue),
          totalCost: Math.round(totalInventoryCost),
          potentialProfit: Math.round(potentialProfit),
          lowStockCount: lowStockItems.length,
          outOfStockCount,
          reorderNeededCount: itemsNeedingReorder.length,
          expiringIn30Days: expiring30Days.length,
          expired
        },
        lowStockAlerts: lowStockItems,
        outOfStockItems,
        fastMovingProducts,
        slowMovingInventory,
        inventoryValue: {
          total: Math.round(totalInventoryValue),
          cost: Math.round(totalInventoryCost),
          potentialProfit: Math.round(potentialProfit),
          byFormulation: Object.keys(inventoryValueByFormulation).map(formulation => ({
            formulation,
            value: Math.round(inventoryValueByFormulation[formulation].value),
            units: inventoryValueByFormulation[formulation].units,
            items: inventoryValueByFormulation[formulation].items
          })).sort((a, b) => b.value - a.value),
          byCategory: Object.keys(inventoryValueByCategory).map(category => ({
            category,
            value: Math.round(inventoryValueByCategory[category])
          })).sort((a, b) => b.value - a.value)
        },
        expiryAlerts: {
          expiring30Days,
          expiring60Days,
          expiring90Days,
          expired
        },
        reorderPointStatus: itemsNeedingReorder,
        vendorPerformance,
        productProfitMargins,
        inventoryTurnover: {
          ratio: parseFloat(inventoryTurnoverRatio),
          cogs: Math.round(cogs),
          avgInventoryCost: Math.round(avgInventoryCost),
          daysInventoryOutstanding,
          analysis: inventoryTurnoverRatio > 4 
            ? 'Excellent - Fast moving inventory' 
            : inventoryTurnoverRatio > 2 
            ? 'Good - Healthy turnover' 
            : 'Low - Consider improving sales or reducing stock'
        },
        period: {
          startDate: start,
          endDate: end,
          daysInPeriod
        }
      }
    });
  } catch (error) {
    console.error('Error fetching inventory analytics:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch inventory analytics',
      error: error.message
    });
  }
};

module.exports = exports;
