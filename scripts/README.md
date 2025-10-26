# 🛠️ Backend Utility Scripts

Collection of utility scripts for database management and testing.

---

## 📋 Available Scripts

### 1. Clear Bookings Only
**File**: `clearBookings.js`

Quickly deletes all appointment bookings from the database.

```bash
node scripts/clearBookings.js
```

**Use Case**: 
- Clean up test bookings
- Reset appointment data
- Remove all booking records

---

### 2. Clear Collections (Interactive)
**File**: `clearCollections.js`

Interactive menu to selectively clear database collections.

```bash
node scripts/clearCollections.js
```

**Options**:
1. Bookings
2. Users
3. Product Orders
4. Reviews
5. Package Assignments
6. Consultations
7. All Collections
0. Cancel

**Features**:
- ✅ Interactive menu
- ✅ Confirmation prompt
- ✅ Selective clearing
- ✅ Bulk clear all option

---

## ⚠️ Important Notes

### **USE WITH CAUTION**
- These scripts **permanently delete** data
- **Cannot be undone**
- Always backup important data first
- Recommended for **development/testing only**

### **Before Running**
1. Make sure `.env` file exists with `MONGO_URI`
2. Verify you're connected to the correct database
3. Double-check which environment you're in (dev/prod)

### **Production Safety**
🚨 **NEVER run these scripts on production database** 🚨

Add environment check before running:
```javascript
if (process.env.NODE_ENV === 'production') {
  console.error('❌ Cannot run cleanup scripts in production!');
  process.exit(1);
}
```

---

## 📝 Examples

### Clear Only Bookings
```bash
cd Backend
node scripts/clearBookings.js
```

Output:
```
🔌 Connecting to MongoDB...
✅ Connected to MongoDB
🗑️  Clearing all bookings...
✅ Successfully deleted 150 bookings
```

### Interactive Collection Clearing
```bash
cd Backend
node scripts/clearCollections.js
```

Output:
```
🔌 Connecting to MongoDB...
✅ Connected to MongoDB

📋 Select collection to clear:
================================
1. Bookings
2. Users
3. Product Orders
4. Reviews
5. Package Assignments
6. Consultations
7. All Collections
0. Cancel

Enter your choice (0-7): 1
⚠️  Are you sure you want to delete ALL Bookings? (yes/no): yes

🗑️  Clearing Bookings...

🎉 Successfully deleted 150 Bookings
```

---

## 🔧 Adding New Cleanup Scripts

To add a new collection cleanup:

1. Import the model in `clearCollections.js`
2. Add to `collections` object
3. Update this README

Example:
```javascript
const NewModel = require('../models/NewModel');

const collections = {
  // ... existing collections
  8: { name: 'New Collection', model: NewModel }
};
```

---

## 🆘 Troubleshooting

### Connection Error
```
❌ Error connecting to database: MongoServerError
```
**Fix**: Check `MONGO_URI` in `.env` file

### Model Not Found
```
❌ Error: Cannot find module '../models/ModelName'
```
**Fix**: Verify model path and name

### Permission Denied
```
❌ Error: User is not authorized
```
**Fix**: Check database user permissions

---

## 📚 Related Documentation

- [MongoDB deleteMany()](https://docs.mongodb.com/manual/reference/method/db.collection.deleteMany/)
- [Mongoose Models](https://mongoosejs.com/docs/models.html)
- [Node.js readline](https://nodejs.org/api/readline.html)

---

**Last Updated**: October 26, 2025  
**Maintainer**: Zennara Development Team
