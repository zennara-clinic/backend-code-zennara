# Consultations API Setup Guide

## Overview
This guide explains how to set up and use the Consultations API for the Zennara backend.

## Database Seeding

### Step 1: Seed Consultations Data
Run the seeding script to populate the database with consultation services:

```bash
node scripts/seedConsultations.js
```

This will:
- Clear existing consultations
- Import 10 consultation services from `data/consultations.json`
- Display success message with seeded items

### Step 2: Verify Seeding
Check that consultations were seeded successfully by visiting:
```
http://localhost:5000/api/consultations
```

## API Endpoints

### Public Endpoints

#### 1. Get All Consultations
```http
GET /api/consultations
```

**Query Parameters:**
- `category` - Filter by category (e.g., "Facial & Peels")
- `search` - Search by name, summary, or tags
- `minPrice` - Minimum price filter
- `maxPrice` - Maximum price filter
- `tags` - Filter by tags (comma-separated)
- `sort` - Sort options: `price_asc`, `price_desc`, `rating`, `popular`, `name`

**Example:**
```
GET /api/consultations?category=Facial%20%26%20Peels&sort=rating
```

#### 2. Get Single Consultation
```http
GET /api/consultations/:identifier
```

**Parameters:**
- `identifier` - Can be: `id`, `slug`, or MongoDB `_id`

**Example:**
```
GET /api/consultations/svc-acne-facial
GET /api/consultations/acne-facial
```

#### 3. Get Consultations by Category
```http
GET /api/consultations/category/:category
```

**Query Parameters:**
- `limit` - Number of results (default: 10)

**Example:**
```
GET /api/consultations/category/Injectables?limit=5
```

#### 4. Get Featured Consultations
```http
GET /api/consultations/featured
```

**Query Parameters:**
- `limit` - Number of results (default: 6)

**Example:**
```
GET /api/consultations/featured?limit=10
```

#### 5. Get All Categories
```http
GET /api/consultations/categories/list
```

**Response:**
```json
{
  "success": true,
  "count": 7,
  "data": [
    "Facial & Peels",
    "Medical Peels",
    "Skin Boosters",
    "Injectables",
    "Body Contouring",
    "Pigmentation",
    "Skin Rejuvenation"
  ]
}
```

#### 6. Search Consultations
```http
GET /api/consultations/search/:query
```

**Query Parameters:**
- `limit` - Number of results (default: 20)

**Example:**
```
GET /api/consultations/search/acne?limit=10
```

## Data Structure

### Consultation Model
```javascript
{
  id: String,              // Unique service ID (e.g., "svc-acne-facial")
  slug: String,            // URL-friendly slug (e.g., "acne-facial")
  name: String,            // Display name
  category: String,        // Category (enum)
  summary: String,         // Short description
  about: String,           // Detailed description
  key_benefits: [String],  // Array of benefits
  ideal_for: [String],     // Array of conditions
  duration_minutes: Number,
  price: Number,
  cta_label: String,
  tags: [String],
  faqs: [{
    q: String,
    a: String
  }],
  pre_care: [String],
  post_care: [String],
  image: String,           // Image URL
  rating: Number,          // 0-5
  reviews: Number,
  isActive: Boolean,
  createdAt: Date,
  updatedAt: Date
}
```

## Available Categories
1. **Facial & Peels** - Basic facial treatments
2. **Medical Peels** - Advanced medical-grade peels
3. **Skin Boosters** - Hydration and rejuvenation treatments
4. **Injectables** - Botox, fillers, etc.
5. **Body Contouring** - Body shaping treatments
6. **Pigmentation** - Treatments for dark spots and melasma
7. **Skin Rejuvenation** - Anti-aging and texture improvement

## Frontend Integration

### API Service (services/api.ts)
The frontend includes a complete `consultationApi` object with methods:

```typescript
import { consultationApi } from '@/services/api';

// Get all consultations
const response = await consultationApi.getAllConsultations({
  category: 'Facial & Peels',
  sort: 'rating'
});

// Get single consultation
const consultation = await consultationApi.getConsultation('svc-acne-facial');

// Search consultations
const results = await consultationApi.searchConsultations('acne', 10);
```

### Pages Using Consultations API
1. **app/(tabs)/consultations.tsx** - Listing page with category filters
2. **app/consultation-detail.tsx** - Detail page with full information

## Testing

### Test All Endpoints
```bash
# Get all consultations
curl http://localhost:5000/api/consultations

# Get by category
curl http://localhost:5000/api/consultations/category/Injectables

# Get single consultation
curl http://localhost:5000/api/consultations/svc-botox-1-unit

# Search
curl http://localhost:5000/api/consultations/search/facial

# Get featured
curl http://localhost:5000/api/consultations/featured?limit=5

# Get categories
curl http://localhost:5000/api/consultations/categories/list
```

## Troubleshooting

### Issue: No consultations returned
**Solution:** Run the seeding script:
```bash
node scripts/seedConsultations.js
```

### Issue: MongoDB connection error
**Solution:** Check your `.env` file has correct `MONGO_URI`

### Issue: Category filter not working
**Solution:** Ensure category name matches exactly (case-sensitive):
- ✅ "Facial & Peels"
- ❌ "Facial and Peels"
- ❌ "facial & peels"

## Adding New Consultations

### Method 1: Via Seed File
1. Edit `data/consultations.json`
2. Add new consultation object
3. Run `node scripts/seedConsultations.js`

### Method 2: Via Database
Insert directly into MongoDB using Compass or CLI

### Method 3: Future API Endpoint
Admin endpoints for CRUD operations (to be implemented)

## Sample Consultations

The seeded data includes:
1. **Acne Facial** - ₹3,500
2. **Acnelan Peel** - ₹7,500
3. **Anti-Aging Facial** - ₹4,800
4. **Aqua Gold Hydration** - ₹15,000
5. **Aqua Gold Rejuvenation** - ₹17,500
6. **Art Lip Filler 1ml** - ₹28,000
7. **Botox (per Unit)** - ₹450
8. **Chin Lipolysis Injection** - ₹22,000
9. **Cosmelan Peel (Face & Neck)** - ₹38,000
10. **Derma Pen (Microneedling)** - ₹9,000

## Notes

- All endpoints are **public** (no authentication required)
- Price is in Indian Rupees (₹)
- Duration is in minutes
- Images use Unsplash URLs
- Text search uses MongoDB text indexes for better performance
