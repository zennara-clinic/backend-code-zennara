const mongoose = require('mongoose');

const appCustomizationSchema = new mongoose.Schema({
  // App Logo
  appLogo: {
    type: String,
    default: 'https://res.cloudinary.com/dgcpuirdo/image/upload/v1749817496/zennara_logo_wtk8lz.png'
  },

  // Home Screen
  homeScreen: {
    /** Section order + visibility for the new-layout home page. */
    sections: [{
      id: { type: String, required: true },
      visible: { type: Boolean, default: true },
    }],
    /** Celebrity/press quotes for the reviews carousel; empty = bundled set. */
    testimonials: [{
      name: { type: String, required: true, trim: true },
      role: { type: String, default: '', trim: true },
      quote: { type: String, required: true, trim: true },
      image: { type: String, default: '' },
    }],
    /** Quick-action tiles; empty = the bundled four. Routes validated app-side. */
    quickActions: [{
      key: { type: String, default: '' },
      label: { type: String, required: true, trim: true },
      image: { type: String, default: '' },
      route: { type: String, default: 'consultation' },
      visible: { type: Boolean, default: true },
    }],
    instagramHandle: { type: String, default: '' },
    instagramUrl: { type: String, default: '' },
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
   * (0.85–1.3), while `typography.sizeOverrides` controls every exact base
   * size used by the active mobile layout. Applied at launch and on refresh.
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
  /**
   * One clinic-wide contact number (the IVR line).
   *
   * Branches each carry their own `contact.phone`, which is right when the
   * clinics answer separately. Zennara routes every call through a single IVR
   * number instead, so this overrides them app-wide when set — one edit rather
   * than one per centre, and no chance of three branches drifting apart.
   *
   * Left EMPTY on purpose. The number dictated for this change ("994332242")
   * is nine digits, and an Indian mobile is ten; nothing should be published
   * until the exact callable sequence is confirmed. While this is blank the
   * app falls back to the branch number, then to the bundled support number,
   * exactly as before.
   */
  contact: {
    /** Clinic-wide phone shown on the header call button and Help screen. */
    phone: { type: String, default: '', trim: true },
    /** WhatsApp number, when it differs from the call line. */
    whatsapp: { type: String, default: '', trim: true },
    email: { type: String, default: '', trim: true },
  },

  /** Help & Support screen — panel-managed FAQs (empty = the app's bundled set). */
  helpScreen: {
    faqs: [{
      q: { type: String, required: true, trim: true },
      a: { type: String, required: true, trim: true },
    }],
  },
  /**
   * The Zen membership card, editable end to end from the panel.
   *
   * `priceInr` remains the ONE authority for what Razorpay charges — see
   * resolveMembershipAmount() in controllers/paymentController.js. `basePrice`
   * and `salePrice` below are presentation: a struck-through "was" figure and
   * the offer beside it. Deriving the charge from a second field is exactly
   * the four-way price drift that had to be undone for consultations, so the
   * charge is read from `priceInr` and nowhere else.
   */
  membership: {
    /** Card name, e.g. "Zen Membership". Empty = the app's bundled wording. */
    name: { type: String, default: '', trim: true },
    tagline: { type: String, default: '', trim: true },
    description: { type: String, default: '', trim: true },

    /** "What's included" list on the membership screen (empty = bundled set). */
    benefits: [{
      title: { type: String, required: true, trim: true },
      copy: { type: String, default: '', trim: true },
    }],

    discountPercent: { type: Number, default: 15, min: 0, max: 100 },

    /**
     * The Zenoti membership this card sells. When set, a Zen membership bought
     * in the app is invoiced in Zenoti against this version id (falls back to
     * the ZENOTI_MEMBERSHIP_VERSION_IDS env when blank).
     */
    zenotiMembershipVersionId: { type: String, default: '', trim: true, lowercase: true },
    zenotiMembershipName: { type: String, default: '', trim: true },
    /** AUTHORITATIVE. What the member is actually charged, in rupees. */
    priceInr: { type: Number, default: 110000, min: 0 },
    /** Struck-through "was" price. 0/absent = show nothing. */
    basePriceInr: { type: Number, default: 0, min: 0 },
    /** Displayed offer price. Presentation only; priceInr still charges. */
    salePriceInr: { type: Number, default: 0, min: 0 },
    /** What a renewal costs. 0 = the same as priceInr. */
    renewalPriceInr: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: 'INR', trim: true },
    /** GST or equivalent, for the breakdown shown on the card. */
    taxPercent: { type: Number, default: 0, min: 0, max: 100 },

    durationMonths: { type: Number, default: 12, min: 1 },

    /** Artwork and call to action. */
    image: { type: String, default: '', trim: true },
    icon: { type: String, default: '', trim: true },
    ctaText: { type: String, default: '', trim: true },
    /** In-app route the CTA opens, e.g. "/profile/membership". */
    ctaDestination: { type: String, default: '', trim: true },

    /** Merchandising. */
    featured: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    displayOrder: { type: Number, default: 0 },

    terms: { type: String, default: '', trim: true },
    /**
     * Branch names where the membership can be bought. Empty = everywhere,
     * which is the current reality and must stay the default.
     */
    branchAvailability: { type: [String], default: [] },
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
    if (screen === 'appearance' || screen === 'copy') {
      // These Mixed fields are complete documents from App Control. Replacing
      // them (instead of merging only supplied keys) makes Reset actually
      // remove old overrides and prevents deleted controls from resurfacing.
      this[screen] = updates[screen];
      this.markModified(screen);
    } else if (this[screen] && typeof this[screen] === 'object' && !Array.isArray(this[screen])) {
      // Handle nested objects (homeScreen, consultationsScreen, etc.)
      Object.keys(updates[screen]).forEach(field => {
        this[screen][field] = updates[screen][field];
      });
    } else {
      // Handle root-level fields (appLogo, etc.)
      this[screen] = updates[screen];
    }
  });

  this.lastUpdatedBy = adminId;
  this.lastUpdatedAt = new Date();
  this.version += 1;

  await this.save();
  return this;
};

module.exports = mongoose.model('AppCustomization', appCustomizationSchema);
