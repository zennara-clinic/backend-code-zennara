# 📦 Inventory & Product Analytics Documentation

## Overview
Comprehensive inventory and product insights system implemented for Zennara Analytics Dashboard.

## 🔗 API Endpoint
```
GET /api/analytics/inventory
```
**Query Parameters:**
- `startDate` (optional) - Start date for sales analysis (default: 30 days ago)
- `endDate` (optional) - End date for sales analysis (default: today)

## 📊 Features Implemented

### 1. 🚨 Low Stock Alerts (Critical Items)
**Description:** Identifies items with stock below 20% of reorder level

**Returns:**
- Inventory name, formulation, organization
- Current stock vs reorder level vs target level
- Shortage quantity
- Severity level (CRITICAL/WARNING)
- Vendor information

**Use Case:** Immediate action needed to prevent stockouts

---

### 2. 🔴 Out of Stock Items Count
**Description:** Complete list of items with zero stock

**Returns:**
- Inventory details
- Days out of stock
- Reorder level information
- Last batch number
- Vendor name

**Use Case:** Priority reordering required

---

### 3. 🔥 Fast-Moving Products (Top Sellers)
**Description:** Top 10 products by sales volume from actual orders

**Returns:**
- Units sold (from ProductOrder data)
- Revenue generated
- Order count
- Current stock level
- Turnover rate (%)
- Average order value

**Use Case:** Stock optimization for high-demand items

---

### 4. 🐌 Slow-Moving Inventory (Dead Stock)
**Description:** Products with stock but no recent sales

**Returns:**
- Inventory value locked
- Days in stock
- Batch information
- Expiry date
- Actionable recommendations (discount/bundle/monitor)

**Use Case:** Identify items for promotions or clearance

---

### 5. 💰 Inventory Value (Total Stock Worth)
**Description:** Complete valuation of inventory

**Returns:**
- **Total Value:** Based on selling prices
- **Total Cost:** Based on buying prices
- **Potential Profit:** Value - Cost
- **By Formulation:** Breakdown with units and item count
- **By Category:** Retail Products vs Consumables

**Use Case:** Financial planning and capital allocation

---

### 6. ⏰ Product Expiry Alerts
**Description:** Items expiring in 30/60/90 days

**Returns:**
- **Expiring in 30 days:** Full details with severity (CRITICAL/HIGH/MEDIUM)
- **Expiring in 60 days:** Count
- **Expiring in 90 days:** Count
- **Already expired:** Count
- Days until expiry
- Value at risk
- Recommended action (immediate discount/plan promotion)

**Use Case:** Prevent inventory write-offs due to expiry

---

### 7. 📋 Reorder Point Status
**Description:** Items at or below reorder level

**Returns:**
- Current stock vs reorder level vs target level
- Shortage quantity
- Urgency level (URGENT/NORMAL)
- Estimated reorder cost
- Vendor information

**Sorting:** URGENT items first, then by shortage quantity

**Use Case:** Purchase order planning

---

### 8. 🤝 Vendor Performance
**Description:** Analysis of each active vendor

**Returns:**
- Items supplied
- Total inventory value
- Low stock items count
- Out of stock items count
- Expiring items count
- Reliability score (%)
- Vendor rating

**Use Case:** Vendor evaluation and relationship management

---

### 9. 📈 Product-wise Profit Margin
**Description:** Top 15 items by profit margin percentage

**Returns:**
- Buying price vs selling price
- Profit per unit
- Margin percentage
- Total potential profit
- Category (High/Good/Low Margin)

**Use Case:** Pricing strategy and profitability analysis

---

### 10. 🔄 Inventory Turnover Ratio
**Description:** How efficiently inventory is being sold

**Formula:** COGS / Average Inventory Cost

**Returns:**
- Turnover ratio
- COGS (Cost of Goods Sold) from actual orders
- Average inventory cost
- Days Inventory Outstanding (DIO)
- Performance analysis:
  - Ratio > 4: Excellent - Fast moving inventory
  - Ratio > 2: Good - Healthy turnover
  - Ratio < 2: Low - Consider improving sales or reducing stock

**Use Case:** Operational efficiency measurement

---

## 📋 Summary Response Structure

```json
{
  "success": true,
  "data": {
    "summary": {
      "totalItems": 150,
      "totalValue": 5000000,
      "totalCost": 3000000,
      "potentialProfit": 2000000,
      "lowStockCount": 12,
      "outOfStockCount": 8,
      "reorderNeededCount": 25,
      "expiringIn30Days": 5,
      "expired": 2
    },
    "lowStockAlerts": [...],
    "outOfStockItems": [...],
    "fastMovingProducts": [...],
    "slowMovingInventory": [...],
    "inventoryValue": {...},
    "expiryAlerts": {...},
    "reorderPointStatus": [...],
    "vendorPerformance": [...],
    "productProfitMargins": [...],
    "inventoryTurnover": {...},
    "period": {
      "startDate": "2025-01-01",
      "endDate": "2025-01-31",
      "daysInPeriod": 30
    }
  }
}
```

## 🔧 Technical Implementation

**Models Used:**
- `Inventory` - Stock levels, batches, pricing, expiry
- `Product` - Product master data
- `ProductOrder` - Sales transactions
- `Vendor` - Supplier information

**Key Fields from Inventory Model:**
- `qohAllBatches` - Quantity on hand (all batches)
- `qohBatchWise` - Quantity per batch
- `reOrderLevel` - Minimum stock trigger
- `targetLevel` - Optimal stock level
- `batchExpiryDate` - Batch expiration
- `inventoryAfterTaxBuyingPrice` - Cost price
- `inventoryAfterTaxSellingPrice` - Selling price
- `vendorName` - Supplier reference

**Performance Optimization:**
- Aggregated queries for vendor stats
- In-memory calculations for turnover
- Filtered queries for date ranges
- Sorted and sliced results for top items

## 🎯 Business Benefits

1. **Prevent Stockouts:** Low stock alerts ensure continuity
2. **Reduce Capital Lock-in:** Identify slow-moving inventory
3. **Minimize Losses:** Expiry alerts prevent write-offs
4. **Optimize Purchasing:** Reorder point analysis
5. **Improve Profitability:** Margin analysis guides pricing
6. **Vendor Management:** Performance tracking enables better negotiations
7. **Operational Efficiency:** Turnover ratio measures performance
8. **Data-Driven Decisions:** Fast vs slow movers guide inventory strategy

## 📱 Usage Example

**Request:**
```bash
GET /api/analytics/inventory?startDate=2025-01-01&endDate=2025-01-31
Authorization: Bearer <admin_token>
```

**Dashboard Display:**
- KPI cards showing summary metrics
- Low stock alerts table with action buttons
- Fast/slow moving products charts
- Expiry alerts with countdown timers
- Vendor performance scorecards
- Profit margin analysis table
- Inventory turnover gauge chart

## 🚀 Future Enhancements
- Real-time stock level updates via WebSockets
- Automated reorder suggestions
- Predictive analytics for demand forecasting
- Integration with supplier APIs
- Batch-wise detailed tracking
- Mobile app notifications for critical alerts
- Custom alert threshold configuration
- Export to Excel/PDF reports

---

**Created:** 2025-01-23  
**Module:** `inventoryAnalyticsController.js`  
**Route:** `/api/analytics/inventory`  
**Authorization:** Admin Only
