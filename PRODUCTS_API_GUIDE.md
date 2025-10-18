# Zennara Products API Guide

## 🚀 Quick Start

The Products Management System is now fully integrated with your Zennara backend!

### Base URL
```
http://localhost:5000/api
```

## 📋 API Endpoints

### Admin Products (Protected - Requires Admin Token)

All admin product endpoints require authentication. Include the admin token in the Authorization header:
```
Authorization: Bearer YOUR_ADMIN_TOKEN
```

#### 1. Get All Products
```http
GET /api/admin/products
```

**Query Parameters:**
- `formulation` - Filter by formulation type (e.g., "Serum", "Face Wash")
- `search` - Search by name, description, or brand
- `isActive` - Filter by active status (true/false)
- `isPopular` - Filter popular products (true/false)
- `sort` - Sort options: name_asc, name_desc, price_asc, price_desc, stock_asc, stock_desc

**Example:**
```http
GET /api/admin/products?formulation=Serum&isActive=true&sort=price_desc
```

**Response:**
```json
{
  "success": true,
  "data": [...products],
  "stats": {
    "total": 7,
    "active": 7,
    "inactive": 0,
    "lowStock": 2,
    "outOfStock": 0,
    "totalValue": 450000
  }
}
```

#### 2. Get Product by ID
```http
GET /api/admin/products/:id
```

**Response:**
```json
{
  "success": true,
  "data": {
    "_id": "...",
    "name": "Hydrating Hyaluronic Serum",
    "description": "...",
    "formulation": "Serum",
    "OrgName": "Zennara Glow",
    "price": 1299,
    "gstPercentage": 18,
    "image": "https://...",
    "stock": 45,
    "rating": 0,
    "reviews": 0,
    "isActive": true,
    "isPopular": true
  }
}
```

#### 3. Create Product
```http
POST /api/admin/products
```

**Request Body:**
```json
{
  "name": "Hydrating Hyaluronic Serum",
  "description": "Advanced hydrating serum with pure hyaluronic acid",
  "formulation": "Serum",
  "OrgName": "Zennara Glow",
  "price": 1299,
  "gstPercentage": 18,
  "image": "https://cloudinary.com/...",
  "stock": 45,
  "isActive": true,
  "isPopular": true
}
```

**Response:**
```json
{
  "success": true,
  "message": "Product created successfully",
  "data": {...product}
}
```

#### 4. Update Product
```http
PUT /api/admin/products/:id
```

**Request Body:** (All fields optional)
```json
{
  "name": "Updated Product Name",
  "price": 1499,
  "stock": 50,
  "isActive": true
}
```

**Response:**
```json
{
  "success": true,
  "message": "Product updated successfully",
  "data": {...updated product}
}
```

#### 5. Delete Product
```http
DELETE /api/admin/products/:id
```

**Response:**
```json
{
  "success": true,
  "message": "Product deleted successfully"
}
```

#### 6. Toggle Product Status
```http
PATCH /api/admin/products/:id/toggle-status
```

**Response:**
```json
{
  "success": true,
  "message": "Product activated successfully",
  "data": {...product}
}
```

#### 7. Update Stock
```http
PATCH /api/admin/products/:id/stock
```

**Request Body:**
```json
{
  "stock": 100
}
```

**Response:**
```json
{
  "success": true,
  "message": "Stock updated successfully",
  "data": {...product}
}
```

#### 8. Bulk Update Products
```http
PATCH /api/admin/products/bulk-update
```

**Request Body:**
```json
{
  "productIds": ["id1", "id2", "id3"],
  "updates": {
    "isActive": true,
    "gstPercentage": 18
  }
}
```

**Response:**
```json
{
  "success": true,
  "message": "3 products updated successfully",
  "modifiedCount": 3
}
```

#### 9. Get Product Statistics
```http
GET /api/admin/products/statistics
```

**Response:**
```json
{
  "success": true,
  "data": {
    "total": 7,
    "active": 7,
    "inactive": 0,
    "popular": 4,
    "lowStock": 2,
    "outOfStock": 0,
    "totalStock": 365,
    "totalValue": 450000,
    "avgPrice": 1185,
    "avgRating": 0,
    "byFormulation": {
      "Serum": { "count": 2, "stock": 95, "value": 120000 },
      "Face Wash": { "count": 1, "stock": 60, "value": 35940 }
    }
  }
}
```

### Public Products (No Authentication Required)

#### Get All Active Products
```http
GET /api/products
```

#### Get Product by ID
```http
GET /api/products/:id
```

#### Get Products by Formulation
```http
GET /api/products/formulation/:formulation
```

#### Search Products
```http
GET /api/products/search/:query
```

#### Get All Formulations
```http
GET /api/products/formulations/list
```

#### Check Stock Availability
```http
POST /api/products/check-stock
```

**Request Body:**
```json
{
  "items": [
    { "productId": "...", "quantity": 2 },
    { "productId": "...", "quantity": 1 }
  ]
}
```

## 🎨 Admin Panel Routes

### Frontend Routes
- `/products` - Products listing page
- `/products/add` - Add new product
- `/products/edit/:id` - Edit existing product

### Features
✅ Beautiful Apple-inspired design
✅ Real-time search and filtering
✅ Image upload with Cloudinary
✅ Stock management
✅ Bulk operations
✅ Statistics dashboard
✅ Responsive grid layout

## 📝 Product Schema

### Required Fields
- `name` - Product name (String)
- `description` - Product description (String)
- `formulation` - Product type (Enum)
- `OrgName` - Brand/Organization name (String)
- `price` - Product price (Number, min: 0)
- `image` - Product image URL (String)

### Optional Fields
- `gstPercentage` - GST percentage (Number, default: 18)
- `stock` - Stock quantity (Number, default: 0)
- `rating` - Product rating (Number, 0-5)
- `reviews` - Number of reviews (Number)
- `isActive` - Active status (Boolean, default: true)
- `isPopular` - Popular flag (Boolean, default: false)

### Available Formulations
- Serum
- Hydrafacial Consumable
- Cream
- Facial Treatment
- Face Wash
- Lipbalm
- Sunscreen Stick
- Sunscreen
- Moisturizer
- Sachets
- Anti Aging
- Pigmentation
- Injection
- Shampoo

## 🔐 Authentication

### Get Admin Token
```http
POST /api/admin/auth/login
```

**Request Body:**
```json
{
  "email": "admin@zennara.com",
  "password": "your_password"
}
```

**Response:**
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "admin": {...}
}
```

Use this token in all admin product requests:
```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

## 🧪 Testing with Postman/Thunder Client

### 1. Login as Admin
```
POST http://localhost:5000/api/admin/auth/login
Body: { "email": "admin@zennara.com", "password": "your_password" }
```

### 2. Copy the token from response

### 3. Test Product Endpoints
```
GET http://localhost:5000/api/admin/products
Headers: Authorization: Bearer YOUR_TOKEN
```

## 🌱 Seeding Products

Run the seed script to populate the database with sample products:

```bash
cd Backend
node seedProducts.js
```

This will create 7 sample products with different formulations.

## 📊 Database Indexes

The Product model has the following indexes for better performance:
- `formulation` - For filtering by product type
- `name, description, OrgName` - Text index for search
- `isActive` - For filtering active/inactive products

## 🎯 Next Steps

1. **Test the API** - Use Postman or Thunder Client to test all endpoints
2. **Access Admin Panel** - Navigate to `/products` in the admin panel
3. **Add Products** - Use the beautiful UI to add new products
4. **Upload Images** - Images are automatically uploaded to Cloudinary
5. **Manage Inventory** - Update stock levels and product status

## 🐛 Troubleshooting

### Server not starting?
- Check if MongoDB is running
- Verify `.env` file has all required variables
- Check for port conflicts (default: 5000)

### Authentication errors?
- Ensure you're using the correct admin token
- Token might be expired - login again
- Check Authorization header format: `Bearer TOKEN`

### Image upload failing?
- Verify Cloudinary credentials in `.env`
- Check file size (max 5MB)
- Ensure file type is image (jpg, png, webp)

## 📞 Support

For issues or questions, check:
- Server logs in terminal
- Browser console for frontend errors
- Network tab for API request/response details

---

**Built with ❤️ for Zennara**
