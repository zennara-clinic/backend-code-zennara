# Zennara Coupon System - Backend Documentation

## Overview
Complete backend implementation for the coupon/discount system in Zennara mobile app.

## Database Model

### Coupon Schema
```javascript
{
  code: String (unique, uppercase, required),
  description: String,
  discountType: String (enum: ['percentage', 'fixed']),
  discountValue: Number (required),
  minOrderValue: Number (default: 0),
  maxDiscount: Number (optional),
  usageLimit: Number (optional),
  usageCount: Number (default: 0),
  perUserLimit: Number (optional),
  validFrom: Date (required),
  validUntil: Date (required),
  applicableProducts: [ObjectId] (ref: Product),
  applicableCategories: [String],
  isActive: Boolean (default: true),
  isPublic: Boolean (default: true),
  timestamps: true
}
```

## API Endpoints

### Public Endpoints

#### 1. Get Available Coupons
**GET** `/api/coupons/available`

Returns all active, public, and valid coupons.

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "_id": "couponId",
      "code": "WELCOME10",
      "description": "Get 10% off on your first order",
      "discountType": "percentage",
      "discountValue": 10,
      "minOrderValue": 500,
      "maxDiscount": 200,
      "validFrom": "2025-01-01T00:00:00.000Z",
      "validUntil": "2025-12-31T23:59:59.000Z",
      "usageLimit": 1000,
      "isActive": true
    }
  ]
}
```

#### 2. Validate Coupon
**POST** `/api/coupons/validate`

Validates a coupon code and calculates discount.

**Request Body:**
```json
{
  "code": "WELCOME10",
  "orderValue": 1000,
  "productIds": ["productId1", "productId2"]
}
```

**Response:**
```json
{
  "success": true,
  "message": "Coupon is valid",
  "data": {
    "coupon": {
      "code": "WELCOME10",
      "discountType": "percentage",
      "discountValue": 10
    },
    "discount": 100
  }
}
```

### Protected Endpoints (Require Authentication)

#### 3. Apply Coupon
**POST** `/api/coupons/apply`

**Headers:** `Authorization: Bearer <token>`

Applies a coupon and increments usage count.

**Request Body:**
```json
{
  "couponId": "couponId",
  "orderId": "orderId"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Coupon applied successfully",
  "data": {
    "couponId": "couponId",
    "code": "WELCOME10",
    "orderId": "orderId"
  }
}
```

### Admin Endpoints (Require Admin Authentication)

#### 4. Get All Coupons
**GET** `/api/admin/coupons`

**Query Parameters:**
- `search`: Search by coupon code
- `isActive`: Filter by active status (true/false)
- `discountType`: Filter by discount type (percentage/fixed)
- `status`: Filter by status (expired/active/upcoming)

#### 5. Get Coupon by ID
**GET** `/api/admin/coupons/:id`

#### 6. Create Coupon
**POST** `/api/admin/coupons`

**Request Body:**
```json
{
  "code": "NEWCODE",
  "description": "Description",
  "discountType": "percentage",
  "discountValue": 15,
  "minOrderValue": 500,
  "maxDiscount": 300,
  "usageLimit": 1000,
  "validFrom": "2025-01-01T00:00:00.000Z",
  "validUntil": "2025-12-31T23:59:59.000Z",
  "isActive": true,
  "isPublic": true
}
```

#### 7. Update Coupon
**PUT** `/api/admin/coupons/:id`

#### 8. Delete Coupon
**DELETE** `/api/admin/coupons/:id`

#### 9. Get Coupon Statistics
**GET** `/api/admin/coupons/statistics`

**Response:**
```json
{
  "success": true,
  "data": {
    "total": 10,
    "active": 7,
    "expired": 2,
    "upcoming": 1,
    "mostUsed": [
      {
        "code": "WELCOME10",
        "usageCount": 450,
        "discountType": "percentage",
        "discountValue": 10
      }
    ]
  }
}
```

## Features

### Coupon Types
1. **Percentage Discount** - Discount as a percentage (e.g., 10% off)
2. **Fixed Amount Discount** - Fixed amount off (e.g., ₹100 off)

### Validations
- ✅ Active status check
- ✅ Date validity (validFrom/validUntil)
- ✅ Usage limit enforcement
- ✅ Minimum order value requirement
- ✅ Maximum discount cap (for percentage)
- ✅ Per-user usage limit (optional)
- ✅ Product/category applicability (optional)
- ✅ Unique coupon codes

### Business Logic
- Automatic usage count increment
- Public/private coupon visibility
- Product-specific and category-specific coupons
- Expired coupon detection
- Available coupon filtering

## Seeding Sample Data

Run the seeder script to populate sample coupons:

```bash
node scripts/seedCoupons.js
```

This will create 8 sample coupons:
1. **WELCOME10** - 10% off (min ₹500)
2. **SKINCARE15** - 15% off skincare (no min)
3. **FLAT100** - ₹100 off (min ₹1000)
4. **ZENNARA20** - 20% off (min ₹750)
5. **MEGA50** - ₹50 off (min ₹500)
6. **VIP25** - 25% off (min ₹1500)
7. **FLAT200** - ₹200 off (min ₹2000)
8. **SUMMER12** - 12% off (no min)

## Usage in Mobile App

### 1. Browse Coupons
User navigates to `/coupons` page and sees all available coupons.

### 2. Apply Coupon
User clicks "Apply" on a coupon card, which:
- Validates eligibility (min order value)
- Calculates discount
- Stores in CartContext
- Navigates back to cart

### 3. Checkout
Applied coupon discount is deducted from total amount.

## Error Handling

### Common Error Responses

**Invalid Coupon:**
```json
{
  "success": false,
  "message": "Invalid coupon code"
}
```

**Expired Coupon:**
```json
{
  "success": false,
  "message": "This coupon has expired"
}
```

**Usage Limit Reached:**
```json
{
  "success": false,
  "message": "This coupon has reached its usage limit"
}
```

**Minimum Order Not Met:**
```json
{
  "success": false,
  "message": "Minimum order value of ₹500 required"
}
```

## Security

- Admin routes protected with `protectAdmin` middleware
- User routes protected with `protect` middleware
- Input validation and sanitization
- Unique coupon code enforcement
- Rate limiting on validation endpoint (recommended)

## Database Indexes

Optimized indexes for better query performance:
- `code: 1` - Fast coupon code lookup
- `isActive: 1` - Filter active coupons
- `validFrom: 1, validUntil: 1` - Date range queries

## Future Enhancements

Potential features for future implementation:
- [ ] User-specific usage tracking (per-user limit enforcement)
- [ ] Coupon redemption history
- [ ] Bulk coupon generation
- [ ] Coupon analytics dashboard
- [ ] Email notifications for new coupons
- [ ] Coupon expiry reminders
- [ ] A/B testing for coupon effectiveness
- [ ] Referral code system
- [ ] Dynamic coupon generation based on user behavior

## Testing

Test the endpoints using the provided Postman collection or with curl:

```bash
# Get available coupons
curl http://localhost:5000/api/coupons/available

# Validate coupon
curl -X POST http://localhost:5000/api/coupons/validate \
  -H "Content-Type: application/json" \
  -d '{"code":"WELCOME10","orderValue":1000}'
```

## Support

For issues or questions, contact the development team.
