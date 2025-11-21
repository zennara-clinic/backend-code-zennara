const mongoose = require('mongoose');

const appCustomizationSchema = new mongoose.Schema({
  // Home Screen
  homeScreen: {
    heroBannerImage: {
      type: String,
      default: 'https://zennara-storage.s3.ap-south-1.amazonaws.com/zennara/Manual+Upload/ZEN+UPDATED+HERO+BANNER.png'
    },
    consultationsButtonText: {
      type: String,
      default: 'Book Consultation'
    },
    productsButtonText: {
      type: String,
      default: 'Shop Products'
    },
    consultationSectionImage: {
      type: String,
      default: null
    },
    zenMembershipCardImage: {
      type: String,
      default: null
    },
    zenMembershipCardTitle: {
      type: String,
      default: 'Zen Membership'
    },
    zenMembershipCardDescription: {
      type: String,
      default: 'Unlock exclusive benefits and save more'
    }
  },

  // Consultations Screen
  consultationsScreen: {
    heading: {
      type: String,
      default: 'Consultations'
    },
    subHeading: {
      type: String,
      default: 'Book your consultation with our expert dermatologists'
    },
    searchbarPlaceholder: {
      type: String,
      default: 'Search consultations...'
    }
  },

  // Appointments Screen
  appointmentsScreen: {
    heading: {
      type: String,
      default: 'My Appointments'
    },
    subHeading: {
      type: String,
      default: 'View and manage your upcoming appointments'
    }
  },

  // Products Screen
  productsScreen: {
    heading: {
      type: String,
      default: 'Products'
    },
    subHeading: {
      type: String,
      default: 'Discover our curated skincare collection'
    },
    searchbarPlaceholder: {
      type: String,
      default: 'Search products...'
    }
  },

  // Profile Screen
  profileScreen: {
    heading: {
      type: String,
      default: 'Profile'
    },
    subHeading: {
      type: String,
      default: 'Manage your account and preferences'
    },
    searchbarPlaceholder: {
      type: String,
      default: 'Search settings...'
    },
    membershipCardText: {
      type: String,
      default: 'Zen Membership'
    },
    ordersCardText: {
      type: String,
      default: 'My Orders'
    },
    appointmentsCardText: {
      type: String,
      default: 'My Appointments'
    },
    addressesCardText: {
      type: String,
      default: 'Saved Addresses'
    }
  },

  // Last updated info
  lastUpdatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Admin',
    default: null
  },
  lastUpdatedAt: {
    type: Date,
    default: Date.now
  },

  // Version for cache busting
  version: {
    type: Number,
    default: 1
  },

  // Active status
  isActive: {
    type: Boolean,
    default: true
  }

}, {
  timestamps: true
});

// Index for efficient queries
appCustomizationSchema.index({ isActive: 1 });

// Static method to get or create customization settings
appCustomizationSchema.statics.getSettings = async function() {
  let settings = await this.findOne({ isActive: true });
  
  if (!settings) {
    // Create default settings if none exist
    settings = await this.create({});
    console.log('✅ Default app customization settings created');
  }
  
  return settings;
};

// Method to update settings
appCustomizationSchema.methods.updateSettings = async function(updates, adminId) {
  // Deep merge updates
  Object.keys(updates).forEach(screen => {
    if (this[screen] && typeof this[screen] === 'object') {
      Object.keys(updates[screen]).forEach(field => {
        this[screen][field] = updates[screen][field];
      });
    }
  });

  this.lastUpdatedBy = adminId;
  this.lastUpdatedAt = new Date();
  this.version += 1;

  await this.save();
  return this;
};

module.exports = mongoose.model('AppCustomization', appCustomizationSchema);
