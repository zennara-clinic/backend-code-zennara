# 🌱 Product Seeder - Setup Guide

## Overview
The product seeder populates your database with 10 sample products across 5 categories, perfect for testing the Products screen in the Zennara mobile app.

## 📦 Products Included

### First Aid (2 products)
- **First Aid Emergency Kit** - ₹899 (Popular) - 50 in stock
- **Digital Infrared Thermometer** - ₹399 (Popular) - 75 in stock

### Pain Relief (2 products)  
- **Pain Relief Gel - Fast Action** - ₹249 (Popular) - 120 in stock
- **Ibuprofen Pain Relief Tablets** - ₹129 - 200 in stock

### Personal Care (2 products)
- **Hand Sanitizer Gel - 500ml** - ₹199 (Popular) - 150 in stock
- **Premium Surgical Face Masks** - ₹299 - 300 in stock

### Skincare (2 products)
- **Hyaluronic Acid Face Serum** - ₹799 (Popular) - 80 in stock
- **Vitamin C Brightening Face Wash** - ₹449 - 100 in stock

### Supplements (2 products)
- **Multivitamin Complete Tablets** - ₹349 (Popular) - 180 in stock
- **Omega-3 Fish Oil Capsules** - ₹699 (Popular) - 90 in stock

**Total:** 10 products | 1,345 total units in stock | 7 popular items

---

## 🚀 How to Run the Seeder

### Option 1: Using NPM Script (Recommended)

```bash
# Navigate to Backend folder
cd Backend

# Run the seeder
npm run seed:products
```

### Option 2: Direct Node Execution

```bash
# Navigate to Backend folder
cd Backend

# Run the seeder directly
node seeders/productSeeder.js
```

---

## ✅ Expected Output

When the seeder runs successfully, you'll see:

```
🔗 Connecting to database...
🗑️  Clearing existing products...
   ✓ Deleted X existing products
🌱 Seeding products...
   ✓ Created 10 new products

✅ Products seeded successfully!

📊 Summary:
   • Total products: 10
   • Categories: First Aid, Pain Relief, Personal Care, Skincare, Supplements
   • Popular products: 7
   • Total stock: 1345 units

📦 Products by Category:

   First Aid (2 products):
      • First Aid Emergency Kit - ₹899 (Stock: 50)
      • Digital Infrared Thermometer - ₹399 (Stock: 75)

   Pain Relief (2 products):
      • Pain Relief Gel - Fast Action - ₹249 (Stock: 120)
      • Ibuprofen Pain Relief Tablets - ₹129 (Stock: 200)

   Personal Care (2 products):
      • Hand Sanitizer Gel - 500ml - ₹199 (Stock: 150)
      • Premium Surgical Face Masks - ₹299 (Stock: 300)

   Skincare (2 products):
      • Hyaluronic Acid Face Serum - ₹799 (Stock: 80)
      • Vitamin C Brightening Face Wash - ₹449 (Stock: 100)

   Supplements (2 products):
      • Multivitamin Complete Tablets - ₹349 (Stock: 180)
      • Omega-3 Fish Oil Capsules - ₹699 (Stock: 90)

🎉 Database is ready! You can now use the Products screen in the mobile app.
```

---

## 🧪 Testing the Mobile App

### Step 1: Ensure Backend is Running

```bash
cd Backend
npm start
```

Backend should be running on: `http://192.168.31.247:5000`

### Step 2: Start the Mobile App

```bash
cd "Zennara App"
npx expo start
```

### Step 3: Check the Products Screen

Open the **Products** tab in the mobile app. You should see:

✅ **Categories** (loaded from backend):
- All
- First Aid
- Pain Relief  
- Personal Care
- Skincare
- Supplements

✅ **Product Cards** with:
- Product images
- Names and descriptions
- Ratings and reviews
- Prices (with Zen Member discounts)
- Add to cart buttons
- Stock availability

✅ **Search Functionality**:
- Search products by name, brand, or description
- Real-time search results
- Highlighted search terms

✅ **Category Filtering**:
- Filter products by category
- Category pills with active states
- Dynamic results count

---

## 🔧 Troubleshooting

### Issue: Connection Error

**Problem:** Cannot connect to database

**Solution:**
1. Check if MongoDB is running
2. Verify `.env` file has correct `MONGO_URI`
3. Ensure network connection

```bash
# Test MongoDB connection
mongosh "your-mongodb-uri"
```

### Issue: No Products in Mobile App

**Problem:** Products screen is empty

**Check:**
1. ✅ Backend is running on correct port
2. ✅ Seeder ran successfully
3. ✅ Mobile app API_BASE_URL is correct

**Debug:**
```bash
# Test products API endpoint
curl http://192.168.31.247:5000/api/products

# Test categories API endpoint  
curl http://192.168.31.247:5000/api/products/categories/list
```

### Issue: Seeder Fails

**Problem:** Error during seeding

**Common Causes:**
- Database connection issues
- Invalid product data
- Missing dependencies

**Solution:**
```bash
# Reinstall dependencies
npm install

# Check .env configuration
cat .env | grep MONGO_URI

# Try running seeder with more logs
node seeders/productSeeder.js
```

---

## 🔄 Re-running the Seeder

The seeder is **safe to run multiple times**. It will:
1. Delete all existing products
2. Insert fresh data
3. Reset everything to initial state

```bash
npm run seed:products
```

---

## 📝 Product Features

Each product includes:

- ✅ **name** - Product title
- ✅ **description** - Detailed description
- ✅ **category** - One of 5 categories
- ✅ **brand** - Zennara brand variants
- ✅ **price** - Regular price
- ✅ **zenMemberPrice** - Discounted price (10% off)
- ✅ **image** - High-quality Unsplash image
- ✅ **stock** - Available quantity
- ✅ **rating** - 4.3 to 4.9 stars
- ✅ **reviews** - Number of customer reviews
- ✅ **isActive** - All products active
- ✅ **isPopular** - 7 popular products

---

## 🎯 Next Steps

After seeding products:

1. ✅ Test the Products screen in mobile app
2. ✅ Test category filtering
3. ✅ Test search functionality
4. ✅ Test add to cart feature
5. ✅ Verify Zen Member pricing
6. ✅ Test cart and checkout flow

---

## 📚 Related Files

- **Seeder:** `Backend/seeders/productSeeder.js`
- **Model:** `Backend/models/Product.js`
- **Routes:** `Backend/routes/product.js`
- **Controller:** `Backend/controllers/productController.js`
- **Mobile Screen:** `Zennara App/app/(tabs)/products.tsx`
- **API Service:** `Zennara App/services/api.ts`

---

## 💡 Tips

- Run seeder whenever you need fresh test data
- All products have realistic stock levels
- Zen Member prices are 10% less than regular prices
- Popular products appear first in listings
- Images are from Unsplash (free to use)
- Products span 5 different categories for variety

---

## 🤝 Support

If you encounter issues:

1. Check console logs in both backend and mobile app
2. Verify all API endpoints are working
3. Ensure database connection is stable
4. Check network configuration (IP address)
5. Review error messages for specific issues

Happy testing! 🎉
