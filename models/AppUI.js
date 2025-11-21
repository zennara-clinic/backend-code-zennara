const mongoose = require('mongoose');

const appUISchema = new mongoose.Schema({
  page: {
    type: String,
    required: [true, 'Page name is required'],
    enum: ['home', 'consultations', 'appointment', 'products', 'profile'],
    unique: true
  },
  
  // Header Section
  header: {
    title: {
      type: String,
      trim: true
    },
    subtitle: {
      type: String,
      trim: true
    },
    backgroundColor: {
      type: String,
      default: '#2C5F4D' // Zennara green
    },
    textColor: {
      type: String,
      default: '#FFFFFF'
    }
  },

  // Hero Banner (for home page)
  heroBanner: {
    enabled: {
      type: Boolean,
      default: false
    },
    image: {
      type: String,
      trim: true
    },
    title: {
      type: String,
      trim: true
    },
    subtitle: {
      type: String,
      trim: true
    },
    buttonText: {
      type: String,
      trim: true
    },
    buttonLink: {
      type: String,
      trim: true
    }
  },

  // Sections (customizable sections for each page)
  sections: [{
    name: {
      type: String,
      trim: true
    },
    title: {
      type: String,
      trim: true
    },
    image: {
      type: String,
      trim: true
    },
    enabled: {
      type: Boolean,
      default: true
    },
    order: {
      type: Number,
      default: 0
    }
  }],

  // Zen Membership Card (for home page)
  zenMembershipCard: {
    enabled: {
      type: Boolean,
      default: false
    },
    image: {
      type: String,
      trim: true
    },
    title: {
      type: String,
      trim: true
    },
    subtitle: {
      type: String,
      trim: true
    },
    buttonText: {
      type: String,
      trim: true
    },
    backgroundColor: {
      type: String,
      default: '#2C5F4D'
    }
  },

  // Profile Cards/Menu Items (for profile page)
  profileCards: [{
    name: {
      type: String,
      trim: true
    },
    title: {
      type: String,
      trim: true
    },
    icon: {
      type: String,
      trim: true
    },
    enabled: {
      type: Boolean,
      default: true
    },
    order: {
      type: Number,
      default: 0
    }
  }],

  // Bottom Banner (like "JOIN THE ZENNARA FAMILY")
  bottomBanner: {
    enabled: {
      type: Boolean,
      default: false
    },
    image: {
      type: String,
      trim: true
    },
    title: {
      type: String,
      trim: true
    },
    buttonText: {
      type: String,
      trim: true
    },
    buttonLink: {
      type: String,
      trim: true
    },
    backgroundColor: {
      type: String,
      default: '#2C5F4D'
    }
  },

  // Theme Colors
  theme: {
    primaryColor: {
      type: String,
      default: '#2C5F4D'
    },
    secondaryColor: {
      type: String,
      default: '#F5F5F5'
    },
    accentColor: {
      type: String,
      default: '#000000'
    },
    backgroundColor: {
      type: String,
      default: '#FFFFFF'
    }
  },

  // Search Bar
  searchBar: {
    enabled: {
      type: Boolean,
      default: true
    },
    placeholder: {
      type: String,
      trim: true
    }
  },

  // Custom Content (JSON field for flexible content)
  customContent: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },

  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Index for better query performance
appUISchema.index({ isActive: 1 });

module.exports = mongoose.model('AppUI', appUISchema);
