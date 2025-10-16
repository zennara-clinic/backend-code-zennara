const mongoose = require('mongoose');

const branchSchema = new mongoose.Schema({
  // Branch Name
  name: {
    type: String,
    required: true,
    trim: true,
    unique: true
  },

  // Branch Address
  address: {
    line1: {
      type: String,
      required: true,
      trim: true
    },
    line2: String,
    city: {
      type: String,
      default: 'Hyderabad'
    },
    state: {
      type: String,
      default: 'Telangana'
    },
    pincode: {
      type: String,
      required: true
    }
  },

  // Contact Information
  contact: {
    phone: [{
      type: String,
      required: true
    }],
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true
    }
  },

  // Location Coordinates (for maps)
  location: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point'
    },
    coordinates: {
      type: [Number], // [longitude, latitude]
      default: [0, 0]
    }
  },

  // Operating Hours
  operatingHours: {
    monday: {
      isOpen: { type: Boolean, default: true },
      openTime: { type: String, default: '10:00' },
      closeTime: { type: String, default: '19:00' }
    },
    tuesday: {
      isOpen: { type: Boolean, default: true },
      openTime: { type: String, default: '10:00' },
      closeTime: { type: String, default: '19:00' }
    },
    wednesday: {
      isOpen: { type: Boolean, default: true },
      openTime: { type: String, default: '10:00' },
      closeTime: { type: String, default: '19:00' }
    },
    thursday: {
      isOpen: { type: Boolean, default: true },
      openTime: { type: String, default: '10:00' },
      closeTime: { type: String, default: '19:00' }
    },
    friday: {
      isOpen: { type: Boolean, default: true },
      openTime: { type: String, default: '10:00' },
      closeTime: { type: String, default: '19:00' }
    },
    saturday: {
      isOpen: { type: Boolean, default: true },
      openTime: { type: String, default: '10:00' },
      closeTime: { type: String, default: '19:00' }
    },
    sunday: {
      isOpen: { type: Boolean, default: true },
      openTime: { type: String, default: '10:00' },
      closeTime: { type: String, default: '19:00' }
    }
  },

  // Slot Configuration
  slotDuration: {
    type: Number,
    default: 30, // in minutes
    min: 15,
    max: 120
  },

  // Status
  isActive: {
    type: Boolean,
    default: true,
    index: true
  },

  // Display Order (for sorting in UI)
  displayOrder: {
    type: Number,
    default: 0
  },

  // Metadata
  description: String,
  amenities: [String],
  images: [String],

}, {
  timestamps: true
});

// Index for geospatial queries
branchSchema.index({ location: '2dsphere' });
branchSchema.index({ isActive: 1, displayOrder: 1 });

// Method to get available time slots for a specific date
branchSchema.methods.getAvailableSlots = function(date) {
  const dayName = date.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
  const daySchedule = this.operatingHours[dayName];
  
  if (!daySchedule || !daySchedule.isOpen) {
    return [];
  }

  const slots = [];
  const [openHour, openMinute] = daySchedule.openTime.split(':').map(Number);
  const [closeHour, closeMinute] = daySchedule.closeTime.split(':').map(Number);
  
  let currentTime = openHour * 60 + openMinute;
  const endTime = closeHour * 60 + closeMinute;
  
  while (currentTime + this.slotDuration <= endTime) {
    const hour = Math.floor(currentTime / 60);
    const minute = currentTime % 60;
    const displayHour = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
    const amPm = hour >= 12 ? 'PM' : 'AM';
    const timeString = `${displayHour}:${minute.toString().padStart(2, '0')} ${amPm}`;
    
    slots.push(timeString);
    currentTime += this.slotDuration;
  }
  
  return slots;
};

// Method to check if branch is open on a specific day
branchSchema.methods.isOpenOnDay = function(dayName) {
  const day = dayName.toLowerCase();
  return this.operatingHours[day] && this.operatingHours[day].isOpen;
};

// Virtual for full address
branchSchema.virtual('fullAddress').get(function() {
  const parts = [
    this.address.line1,
    this.address.line2,
    this.address.city,
    this.address.state,
    this.address.pincode
  ].filter(Boolean);
  return parts.join(', ');
});

// Virtual for formatted phone numbers
branchSchema.virtual('formattedPhone').get(function() {
  return this.contact.phone.map(phone => {
    if (phone.startsWith('+91')) return phone;
    return `+91 ${phone}`;
  }).join(' / ');
});

module.exports = mongoose.model('Branch', branchSchema);
