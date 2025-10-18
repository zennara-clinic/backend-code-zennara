# Vendors Seeding Guide

## Overview
This guide explains how to seed the database with sample vendor data for the Zennara Admin Panel.

## Files Created
1. **`data/vendors.json`** - Contains 12 sample vendors with complete information
2. **`scripts/seedVendors.js`** - Script to populate the database

## Sample Vendors Included

The seeder includes 12 specialized dermatology & cosmetic clinic vendors:

1. **DermaCare Pharmaceuticals Pvt Ltd** - Mumbai, Maharashtra (5⭐)
   - Serums, Medical-grade creams, Dermatological pharmaceuticals
   
2. **Medical Aesthetics Supply India** - Bangalore, Karnataka (5⭐)
   - Dermal Fillers, Botox Injections, Medical injectables
   
3. **SkinVitals Dermatology Products** - Ahmedabad, Gujarat (5⭐)
   - Moisturizers, Sunscreens, Cleansers, Retinols
   
4. **HydraFacial Systems India** - Pune, Maharashtra (5⭐)
   - HydraFacial consumables, Dermapen cartridges, Facial equipment
   
5. **Chemical Peels & Cosmelan India** - Hyderabad, Telangana (5⭐)
   - Cosmelan products, Chemical peels, Pigmentation treatments
   
6. **DermaHair Solutions Pvt Ltd** - Chennai, Tamil Nadu (4⭐)
   - Hair shampoos, Serums, GFC kits, Hair colors
   
7. **Advanced Skin Serums India** - Delhi (5⭐)
   - Vitamin C serums, Anti-aging serums, Exosome therapy
   
8. **Nutraceuticals & Supplements India** - Jaipur, Rajasthan (4⭐)
   - Collagen powders, Tablets, Capsules, Oral supplements
   
9. **Clinical Acne Solutions** - Kochi, Kerala (3⭐, Inactive)
   - Acne care products, Cleansers, Gels, Anti-bacterial treatments
   
10. **Professional Face Masks & Treatments** - Dehradun, Uttarakhand (5⭐)
    - Face masks, Facial treatments, Ointments, Therapeutic gels
    
11. **Pigmentation & Brightening Specialists** - Noida, Uttar Pradesh (4⭐)
    - Anti-pigmentation creams, Brightening solutions, Melasma treatments
    
12. **CosmeticPharma Supplies Ltd** - Ludhiana, Punjab (5⭐)
    - Lip balms, Under-eye creams, Sprays, Powders, Sachets

## Vendor Data Structure

Each vendor includes:
- ✅ Basic Information (Name, Contact Person, Email, Phone)
- ✅ Complete Address (Address, City, State, Pincode)
- ✅ Tax Details (GST Number, PAN Number)
- ✅ Bank Details (Account Number, IFSC Code, Bank Name, Account Holder)
- ✅ Status (Active/Inactive)
- ✅ Rating (0-5 stars)
- ✅ Notes

## How to Seed the Database

### Step 1: Navigate to Backend Directory
```bash
cd "c:\Users\Khushnoor\Desktop\Zennara V2\Backend"
```

### Step 2: Run the Seeding Script
```bash
node scripts/seedVendors.js
```

### Step 3: Verify Seeding
Check your MongoDB database or visit the Vendors Management page in the admin panel.

## Expected Output

When you run the seeder, you should see:
```
✅ MongoDB connected for seeding
🗑️  Clearing existing vendors...
📦 Seeding vendors...
✅ 12 vendors seeded successfully!

📋 Seeded vendors:
   1. Herbal Essence Suppliers Pvt Ltd - Mumbai, Maharashtra - Active - Rating: 5⭐
   2. Aromatherapy Oils India - Bangalore, Karnataka - Active - Rating: 4⭐
   ...

📊 Summary:
   Active: 11
   Inactive: 1
```

## Database Collections

After seeding, the `vendors` collection will contain:
- 12 vendor documents
- 11 Active vendors
- 1 Inactive vendor
- Complete contact and business information
- Bank and tax details for all vendors

## Testing the Integration

1. **View Vendors**: Visit `http://localhost:5173/inventory/vendors` in your admin panel
2. **Verify Stats**: Should show:
   - Total Vendors: 12
   - Active Vendors: 11
   - Inactive Vendors: 1
3. **Test Filtering**: Use the status filter to view Active/Inactive vendors
4. **Test Search**: Search for vendors by name, contact, or email
5. **Test Edit**: Click edit on any vendor to see all details
6. **Test Delete**: Try deleting a vendor (note: vendors with products cannot be deleted)

## Notes

- ⚠️ **Warning**: This script will DELETE all existing vendors before seeding
- 📝 All GST and PAN numbers are sample data (not real)
- 🏦 Bank account numbers are dummy data for testing purposes
- 📞 Phone numbers follow Indian format (+91 XXXXXXXXXX)
- 🏢 Vendors cover multiple Indian states for diversity

## Customization

To add more vendors or modify existing ones:
1. Edit `data/vendors.json`
2. Follow the same structure as existing entries
3. Ensure all required fields are present (name, contactPerson, email, phone, address)
4. Run the seeder again

## Integration with Products

These vendors are designed to work with the Zennara product management system:
- When creating/editing products, you can assign them to these vendors
- The `productsSupplied` count will automatically update based on product associations
- Vendors with associated products cannot be deleted (safety feature)

## Troubleshooting

### MongoDB Connection Error
```bash
❌ MongoDB connection error
```
**Solution**: Check your `.env` file has correct `MONGO_URI` or `MONGODB_URI`

### Duplicate Key Error
```bash
E11000 duplicate key error
```
**Solution**: The seeder clears all vendors first, but if you have unique constraints, check your database

### Missing Fields Error
```bash
Vendor validation failed
```
**Solution**: Ensure all required fields in `vendors.json` are present and valid

## Next Steps

After seeding:
1. ✅ Visit the Vendors Management page
2. ✅ Test all CRUD operations (Create, Read, Update, Delete)
3. ✅ Assign vendors to products
4. ✅ Test filtering and search functionality
5. ✅ Verify stats are calculating correctly

## Support

For issues or questions:
- Check the Vendor model: `models/Vendor.js`
- Review the API routes: `routes/vendor.js`
- Check the controller: `controllers/vendorController.js`
