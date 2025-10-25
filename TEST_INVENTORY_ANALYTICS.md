# 🧪 Testing Inventory Analytics

## Quick Test Commands

### 1. Test Inventory Analytics Endpoint
```bash
# Basic request (last 30 days)
GET http://localhost:5000/api/analytics/inventory
Authorization: Bearer <your_admin_token>

# With date range
GET http://localhost:5000/api/analytics/inventory?startDate=2025-01-01&endDate=2025-01-31
Authorization: Bearer <your_admin_token>
```

### 2. Expected Response Structure
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
    "lowStockAlerts": [
      {
        "id": "...",
        "inventoryName": "Product Name",
        "currentStock": 2,
        "reorderLevel": 10,
        "shortage": 8,
        "severity": "WARNING"
      }
    ],
    "outOfStockItems": [...],
    "fastMovingProducts": [...],
    "slowMovingInventory": [...],
    "inventoryValue": {...},
    "expiryAlerts": {...},
    "reorderPointStatus": [...],
    "vendorPerformance": [...],
    "productProfitMargins": [...],
    "inventoryTurnover": {...}
  }
}
```

### 3. Postman Collection
Import this JSON into Postman:

```json
{
  "info": {
    "name": "Zennara Inventory Analytics",
    "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
  },
  "item": [
    {
      "name": "Get Inventory Analytics",
      "request": {
        "method": "GET",
        "header": [
          {
            "key": "Authorization",
            "value": "Bearer {{admin_token}}",
            "type": "text"
          }
        ],
        "url": {
          "raw": "{{base_url}}/api/analytics/inventory",
          "host": ["{{base_url}}"],
          "path": ["api", "analytics", "inventory"]
        }
      }
    },
    {
      "name": "Get Inventory Analytics (Date Range)",
      "request": {
        "method": "GET",
        "header": [
          {
            "key": "Authorization",
            "value": "Bearer {{admin_token}}",
            "type": "text"
          }
        ],
        "url": {
          "raw": "{{base_url}}/api/analytics/inventory?startDate=2025-01-01&endDate=2025-01-31",
          "host": ["{{base_url}}"],
          "path": ["api", "analytics", "inventory"],
          "query": [
            {
              "key": "startDate",
              "value": "2025-01-01"
            },
            {
              "key": "endDate",
              "value": "2025-01-31"
            }
          ]
        }
      }
    }
  ],
  "variable": [
    {
      "key": "base_url",
      "value": "http://localhost:5000"
    },
    {
      "key": "admin_token",
      "value": "your_admin_jwt_token_here"
    }
  ]
}
```

## 🔍 Testing Checklist

- [ ] Endpoint returns 200 status
- [ ] Summary metrics are present
- [ ] Low stock alerts show items below 20% of reorder level
- [ ] Out of stock items have zero quantity
- [ ] Fast-moving products calculated from ProductOrder data
- [ ] Slow-moving products identified (stock but no sales)
- [ ] Inventory value calculations correct (selling - buying)
- [ ] Expiry alerts show items by 30/60/90 day windows
- [ ] Reorder point status sorted by urgency
- [ ] Vendor performance includes reliability scores
- [ ] Profit margins calculated correctly
- [ ] Inventory turnover ratio computed from COGS

## 🐛 Common Issues & Solutions

### Issue 1: Empty Response
**Cause:** No inventory data in database  
**Solution:** Add sample inventory items first

### Issue 2: Missing Fast-Moving Products
**Cause:** No ProductOrder data in date range  
**Solution:** Adjust date range or create test orders

### Issue 3: Zero Turnover Ratio
**Cause:** No sales in period or zero inventory cost  
**Solution:** Check if orders exist and inventory has buying prices

### Issue 4: Authorization Error
**Cause:** Invalid or missing admin token  
**Solution:** Use protectAdmin middleware, ensure admin login

## 📊 Sample Dashboard Integration

```javascript
// Frontend example (React)
const fetchInventoryAnalytics = async (startDate, endDate) => {
  try {
    const response = await axios.get('/api/analytics/inventory', {
      params: { startDate, endDate },
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    
    const { data } = response.data;
    
    // Update dashboard state
    setSummaryMetrics(data.summary);
    setLowStockAlerts(data.lowStockAlerts);
    setFastMovers(data.fastMovingProducts);
    setExpiryAlerts(data.expiryAlerts);
    setVendorPerformance(data.vendorPerformance);
    
  } catch (error) {
    console.error('Failed to fetch inventory analytics:', error);
  }
};
```

## ✅ Success Indicators

1. **Low Stock Alerts** properly identify critical items
2. **Fast/Slow Movers** reflect actual sales data
3. **Expiry Alerts** show accurate countdown days
4. **Vendor Performance** aggregates by supplier
5. **Profit Margins** calculate from buying/selling prices
6. **Turnover Ratio** provides actionable insights

---

**Ready to Test!** 🚀
