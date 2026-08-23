const mongoose = require('mongoose');

const appCustomizationSchema = new mongoose.Schema({
  // App Logo
  appLogo: {
    type: String,
    default: 'https://res.cloudinary.com/dgcpuirdo/image/upload/v1749817496/zennara_logo_wtk8lz.png'
  },

  // Home Screen
  homeScreen: {
    heroBannerImage: {
      type: String,
      default: 'https://zennara-storage.s3.ap-south-1.amazonaws.com/zennara/Manual+Upload/ZEN+UPDATED+HERO+BANNER.png'
    },
    heroBannerRoute: {
      type: String,
      enum: ['consultations', 'products', 'appointments', 'profile'],
      default: 'consultations'
    },
    consultationsButtonText: {
      type: String,
      default: 'Book Consultation'
    },
    productsButtonText: {
      type: String,
      default: 'Shop Products'
    },
    consultationCategoryCards: {
      type: [{
        image: {
          type: String,
          required: true
        },
        categoryName: {
          type: String,
          required: true
        },
        searchTerm: {
          type: String,
          required: true
        },
        displayOrder: {
          type: Number,
          default: 0
        }
      }],
      default: [
        {
          image: 'https://zennara-storage.s3.ap-south-1.amazonaws.com/zennara/Manual+Upload/SKIN.png',
          categoryName: 'Skin',
          searchTerm: 'Skin',
          displayOrder: 1
        },
        {
          image: 'https://zennara-storage.s3.ap-south-1.amazonaws.com/zennara/Manual+Upload/HAIR.png',
          categoryName: 'Hair',
          searchTerm: 'Hair',
          displayOrder: 2
        },
        {
          image: 'https://zennara-storage.s3.ap-south-1.amazonaws.com/zennara/Manual+Upload/FACIALS.png',
          categoryName: 'Facials',
          searchTerm: 'Facials',
          displayOrder: 3
        },
        {
          image: 'https://zennara-storage.s3.ap-south-1.amazonaws.com/zennara/Manual+Upload/AESTHETICS.png',
          categoryName: 'Aesthetics',
          searchTerm: 'Aesthetics',
          displayOrder: 4
        }
      ]
    },
    // Section Headings and Button Texts
    consultationsSectionHeading: {
      type: String,
      default: 'Consultations'
    },
    consultationsSectionButtonText: {
      type: String,
      default: 'See All'
    },
    popularConsultationsSectionHeading: {
      type: String,
      default: 'Popular Consultations'
    },
    popularConsultationsSectionButtonText: {
      type: String,
      default: 'See All'
    },
    popularProductsSectionHeading: {
      type: String,
      default: 'Popular Products'
    },
    popularProductsSectionButtonText: {
      type: String,
      default: 'See All'
    },
    /**
     * Instagram reel permalinks featured in the "From our clinic" rail,
     * newest first. The app has always read this key; it was never declared
     * here, so every panel value was dropped and the rail silently fell back
     * to the list bundled in the build. Accepts /reel/, /reels/, /p/ and /tv/
     * URLs — the app extracts the shortcode and ignores anything else.
     */
    reels: {
      type: [String],
      default: []
    },
    /**
     * Self-hosted clips for the same rail. An Instagram embed inside a
     * WebView cannot be relied on to play on iOS, so the clinic uploads the
     * reel's MP4 here and the app plays it natively; `permalink` keeps the
     * "View on Instagram" link. When this list has entries it is what the
     * rail shows; `reels` is only used when it is empty.
     */
    reelVideos: {
      type: [{
        url: { type: String, required: true },
        poster: { type: String, default: '' },
        permalink: { type: String, default: '' },
        title: { type: String, default: '' }
      }],
      default: []
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

  /**
   * Commercial settings the panel and app both read. The Zen member discount
   * used to be a literal in the therapist screen; it lives here so the clinic
   * can change it without a deploy.
   */
  /**
   * Remote design system for the app. `colors` is a flat map of theme tokens
   * (dot paths for text.*, e.g. "text.primary") to colour strings; empty means
   * the bundled palette. `typography.fontScale` multiplies every type size
   * (0.85–1.3). Applied by the app at launch and on refresh.
   */
  appearance: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  /**
   * Copy overrides: key → text, keys from the app's constants/copy.ts registry
   * (mirrored in the panel's editor). Empty string = use the bundled wording.
   */
  copy: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  membership: {
    discountPercent: { type: Number, default: 15, min: 0, max: 100 },
    priceInr: { type: Number, default: 110000 },
    durationMonths: { type: Number, default: 12 }
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
    personalCardText: {
      type: String,
      default: 'Personal'
    },
    addressesCardText: {
      type: String,
      default: 'Addresses'
    },
    bankDetailsCardText: {
      type: String,
      default: 'Bank Details'
    },
    membershipCardText: {
      type: String,
      default: 'Membership'
    },
    ordersCardText: {
      type: String,
      default: 'Orders'
    },
    treatmentsCardText: {
      type: String,
      default: 'Treatments'
    },
    appointmentsCardText: {
      type: String,
      default: 'Appointments'
    },
    formsCardText: {
      type: String,
      default: 'Forms'
    },
    helpCardText: {
      type: String,
      default: 'Help'
    },
    deleteCardText: {
      type: String,
      default: 'Delete'
    },
    termsCardText: {
      type: String,
      default: 'Terms'
    },
    privacyCardText: {
      type: String,
      default: 'Privacy'
    }
  },

  /**
   * Legal documents, in plain text, edited in the panel.
   *
   * These were already living on this document — `updateLegalContent.js` wrote
   * them — but were never declared here, so mongoose's strict mode silently
   * dropped them on the next panel save. Declaring them is what makes them
   * survive an edit. Empty means "not published"; the app then renders its own
   * bundled copy rather than a blank page.
   *
   * The app parses the conventions these already follow: "1. HEADING" in upper
   * case is a section, "3.1 Subheading" a subsection, a leading bullet a list
   * item, and a first "Last Updated: …" line becomes the revision date shown
   * under the title. Keep to those and the rendering follows.
   */
  termsOfService: {
    type: String,
    default: ''
  },
  privacyPolicy: {
    type: String,
    default: ''
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
    if (this[screen] && typeof this[screen] === 'object' && !Array.isArray(this[screen])) {
      // Handle nested objects (homeScreen, consultationsScreen, etc.)
      Object.keys(updates[screen]).forEach(field => {
        this[screen][field] = updates[screen][field];
      });
    } else {
      // Handle root-level fields (appLogo, etc.)
      this[screen] = updates[screen];
    }
    // Mixed fields (appearance, copy) don't track nested mutation on their own.
    if (screen === 'appearance' || screen === 'copy') this.markModified(screen);
  });

  this.lastUpdatedBy = adminId;
  this.lastUpdatedAt = new Date();
  this.version += 1;

  await this.save();
  return this;
};

module.exports = mongoose.model('AppCustomization', appCustomizationSchema);
