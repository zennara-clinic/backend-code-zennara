const mongoose = require('mongoose');
const Branch = require('../models/Branch');
require('dotenv').config();

const branches = [
  {
    name: 'Jubilee Hills',
    address: {
      line1: 'House no 8-2-293/82/A/454/A',
      line2: 'Road no 19, Jubilee Hills',
      city: 'Hyderabad',
      state: 'Telangana',
      pincode: '500033'
    },
    contact: {
      phone: ['7070701099'],
      email: 'info@zennara.in'
    },
    location: {
      type: 'Point',
      coordinates: [78.4089, 17.4326] // [longitude, latitude] for Jubilee Hills
    },
    operatingHours: {
      monday: { isOpen: true, openTime: '10:00', closeTime: '19:00' },
      tuesday: { isOpen: true, openTime: '10:00', closeTime: '19:00' },
      wednesday: { isOpen: true, openTime: '10:00', closeTime: '19:00' },
      thursday: { isOpen: true, openTime: '10:00', closeTime: '19:00' },
      friday: { isOpen: true, openTime: '10:00', closeTime: '19:00' },
      saturday: { isOpen: true, openTime: '10:00', closeTime: '19:00' },
      sunday: { isOpen: true, openTime: '10:00', closeTime: '19:00' }
    },
    slotDuration: 30,
    isActive: true,
    displayOrder: 1,
    description: 'Our flagship branch in the heart of Jubilee Hills, offering comprehensive wellness services.',
    amenities: ['Parking Available', 'Wheelchair Accessible', 'Wi-Fi', 'Waiting Lounge']
  },
  {
    name: 'Kokapet',
    address: {
      line1: 'Plot No. 202 & 203, Myscape Stories',
      line2: 'Financial District',
      city: 'Hyderabad',
      state: 'Telangana',
      pincode: '500032'
    },
    contact: {
      phone: ['7075505891', '7075505961'],
      email: 'kokapet@zennara.in'
    },
    location: {
      type: 'Point',
      coordinates: [78.3428, 17.4052] // [longitude, latitude] for Kokapet/Financial District
    },
    operatingHours: {
      monday: { isOpen: true, openTime: '10:00', closeTime: '19:00' },
      tuesday: { isOpen: true, openTime: '10:00', closeTime: '19:00' },
      wednesday: { isOpen: true, openTime: '10:00', closeTime: '19:00' },
      thursday: { isOpen: true, openTime: '10:00', closeTime: '19:00' },
      friday: { isOpen: true, openTime: '10:00', closeTime: '19:00' },
      saturday: { isOpen: true, openTime: '10:00', closeTime: '19:00' },
      sunday: { isOpen: true, openTime: '10:00', closeTime: '19:00' }
    },
    slotDuration: 30,
    isActive: true,
    displayOrder: 2,
    description: 'Modern wellness center in the Financial District, perfect for professionals.',
    amenities: ['Parking Available', 'Cafeteria', 'Wi-Fi', 'Conference Room']
  },
  {
    name: 'Kondapur',
    address: {
      line1: 'Fortune Cyber, 4th floor, #4, 134',
      line2: 'Gachibowli - Miyapur Rd, Golden Habitat, Whitefields',
      city: 'Hyderabad',
      state: 'Telangana',
      pincode: '500081'
    },
    contact: {
      phone: ['8977759580', '8977759581'],
      email: 'kondapur@zennara.in'
    },
    location: {
      type: 'Point',
      coordinates: [78.3647, 17.4629] // [longitude, latitude] for Kondapur
    },
    operatingHours: {
      monday: { isOpen: true, openTime: '10:00', closeTime: '19:00' },
      tuesday: { isOpen: true, openTime: '10:00', closeTime: '19:00' },
      wednesday: { isOpen: true, openTime: '10:00', closeTime: '19:00' },
      thursday: { isOpen: true, openTime: '10:00', closeTime: '19:00' },
      friday: { isOpen: true, openTime: '10:00', closeTime: '19:00' },
      saturday: { isOpen: true, openTime: '10:00', closeTime: '19:00' },
      sunday: { isOpen: true, openTime: '10:00', closeTime: '19:00' }
    },
    slotDuration: 30,
    isActive: true,
    displayOrder: 3,
    description: 'Conveniently located in Kondapur, serving the IT corridor with premium wellness services.',
    amenities: ['Parking Available', 'Wheelchair Accessible', 'Wi-Fi', 'Elevator Access']
  }
];

const seedBranches = async () => {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ MongoDB connected for seeding');

    // Clear existing branches
    await Branch.deleteMany({});
    console.log('🗑️  Cleared existing branches');

    // Insert new branches
    const createdBranches = await Branch.insertMany(branches);
    console.log(`✅ Successfully seeded ${createdBranches.length} branches:`);
    
    createdBranches.forEach(branch => {
      console.log(`   📍 ${branch.name} - ${branch.contact.email}`);
    });

    console.log('\n🎉 Branch seeding completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error seeding branches:', error);
    process.exit(1);
  }
};

// Run the seeder
seedBranches();
