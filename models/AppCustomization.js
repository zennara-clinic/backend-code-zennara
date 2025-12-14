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
    showLogoTagline: {
      type: Boolean,
      default: true
    },
    logoTaglineLine1: {
      type: String,
      default: 'Skin.'
    },
    logoTaglineLine2: {
      type: String,
      default: 'Aesthetics.'
    },
    logoTaglineLine3: {
      type: String,
      default: 'Wellness.'
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

  // Legal Content
  termsOfService: {
    type: String,
    default: `Last Updated: December 15, 2024

Welcome to Zennara Clinic. By accessing or using our mobile application and services, you agree to be bound by these Terms of Service ("Terms"). Please read them carefully.

1. ACCEPTANCE OF TERMS

By creating an account or using our services, you agree to these Terms and our Privacy Policy. If you do not agree, please do not use our app or services.

2. DESCRIPTION OF SERVICES

Zennara Clinic provides:
• Online consultation booking for dermatology and aesthetic services
• Product purchases for skincare and wellness
• Appointment management and scheduling
• Medical forms and pre-consultation assessments
• Treatment tracking and history
• Membership programs and exclusive benefits

3. USER ACCOUNTS

3.1 Registration
You must provide accurate, current, and complete information during registration. You are responsible for maintaining the confidentiality of your account credentials.

3.2 Account Security
You are responsible for all activities that occur under your account. Notify us immediately of any unauthorized use or security breaches.

3.3 Age Requirement
You must be at least 18 years old to use our services. If you are under 18, you must use our services under the supervision of a parent or legal guardian.

4. CONSULTATIONS AND APPOINTMENTS

4.1 Booking
Consultations and appointments are subject to availability. We reserve the right to refuse or cancel bookings at our discretion.

4.2 Cancellation Policy
• Appointments may be cancelled up to 24 hours before the scheduled time
• Late cancellations may be subject to fees
• No-shows may result in booking restrictions

4.3 Medical Advice
Consultations provided through our app are for informational purposes. They do not replace in-person medical examinations. Always seek immediate medical attention for emergencies.

5. PRODUCTS AND PURCHASES

5.1 Product Information
We strive to provide accurate product descriptions and pricing. We reserve the right to correct any errors and cancel orders if necessary.

5.2 Payment
All purchases must be paid in full at the time of order. We accept various payment methods as displayed in the app.

5.3 Delivery
Products will be delivered to the address provided during checkout. Delivery times are estimates and not guarantees.

5.4 Returns and Refunds
• Products must be returned within 7 days of delivery
• Products must be unused and in original packaging
• Refunds will be processed within 7-10 business days
• Certain products may not be eligible for returns due to hygiene reasons

6. MEMBERSHIP PROGRAMS

6.1 Zen Membership
Membership benefits, pricing, and terms are subject to change with notice. Memberships are non-transferable.

6.2 Billing
Membership fees are billed according to the selected plan. Failure to pay may result in suspension or termination of membership benefits.

7. USER CONDUCT

You agree not to:
• Use the app for any unlawful purpose
• Impersonate any person or entity
• Interfere with or disrupt the app's functionality
• Attempt to gain unauthorized access to our systems
• Post or transmit harmful, offensive, or inappropriate content
• Collect or harvest user information without consent

8. INTELLECTUAL PROPERTY

All content, trademarks, logos, and intellectual property on our app are owned by Zennara Clinic or our licensors. You may not use, reproduce, or distribute any content without our written permission.

9. PRIVACY AND DATA PROTECTION

Your privacy is important to us. Please review our Privacy Policy to understand how we collect, use, and protect your personal information.

10. DISCLAIMER OF WARRANTIES

Our services are provided "as is" without warranties of any kind, either express or implied. We do not guarantee:
• Uninterrupted or error-free service
• Accuracy or reliability of information
• Specific results from consultations or treatments

11. LIMITATION OF LIABILITY

To the maximum extent permitted by law, Zennara Clinic shall not be liable for:
• Indirect, incidental, or consequential damages
• Loss of profits, data, or business opportunities
• Damages exceeding the amount paid for services in the past 12 months

12. INDEMNIFICATION

You agree to indemnify and hold harmless Zennara Clinic, its officers, employees, and partners from any claims, damages, or expenses arising from:
• Your use of our services
• Your violation of these Terms
• Your violation of any rights of another party

13. MODIFICATIONS TO TERMS

We reserve the right to modify these Terms at any time. Changes will be effective immediately upon posting in the app. Your continued use of our services constitutes acceptance of modified Terms.

14. TERMINATION

We may suspend or terminate your account at any time for:
• Violation of these Terms
• Fraudulent or illegal activity
• Extended periods of inactivity
• At your request

Upon termination, you must cease using our services, and we may delete your account data.

15. DISPUTE RESOLUTION

15.1 Governing Law
These Terms are governed by the laws of India without regard to conflict of law principles.

15.2 Arbitration
Any disputes shall be resolved through binding arbitration in accordance with Indian arbitration laws. You waive the right to participate in class actions.

15.3 Jurisdiction
Any legal actions must be brought in the courts located in the jurisdiction where Zennara Clinic operates.

16. GENERAL PROVISIONS

16.1 Entire Agreement
These Terms constitute the entire agreement between you and Zennara Clinic regarding our services.

16.2 Severability
If any provision is found unenforceable, the remaining provisions will continue in full effect.

16.3 Waiver
Our failure to enforce any right or provision does not constitute a waiver of such right or provision.

16.4 Assignment
You may not assign or transfer these Terms. We may assign our rights without restriction.

17. CONTACT INFORMATION

For questions about these Terms, please contact us at:
Zennara Clinic
Email: support@zennaraclinic.com
Phone: [Contact Number]
Address: [Clinic Address]

By using our services, you acknowledge that you have read, understood, and agree to be bound by these Terms of Service.`
  },
  privacyPolicy: {
    type: String,
    default: `Last Updated: December 15, 2024

Zennara Clinic ("we," "our," or "us") is committed to protecting your privacy. This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you use our mobile application and services.

1. INFORMATION WE COLLECT

1.1 Personal Information
We collect information that identifies you personally, including:
• Full name
• Email address
• Phone number
• Date of birth
• Gender
• Profile photograph

1.2 Medical Information
For consultations and treatments, we collect:
• Medical history and conditions
• Skin concerns and issues
• Current medications and allergies
• Treatment preferences
• Pre-consultation form responses
• Photos of treatment areas (when provided)
• Appointment and consultation notes

1.3 Payment Information
We collect payment details including:
• Credit/debit card information (processed securely through payment gateways)
• Billing address
• Transaction history
• Bank account details (for refunds)
• UPI IDs

1.4 Location Information
With your permission, we may collect:
• Device location data
• Delivery addresses
• Appointment location preferences

1.5 Usage Information
We automatically collect:
• App usage patterns and preferences
• Device information (model, OS version, unique identifiers)
• IP address and network information
• Log data and error reports
• Pages viewed and features used

1.6 Communication Data
We store:
• Chat messages and support inquiries
• Email correspondence
• Feedback and reviews
• Push notification preferences

2. HOW WE USE YOUR INFORMATION

We use your information to:

2.1 Provide Services
• Process consultations and appointments
• Deliver purchased products
• Manage your account and membership
• Process payments and refunds
• Send order confirmations and updates

2.2 Improve Services
• Analyze app usage and performance
• Personalize your experience
• Develop new features and services
• Conduct research and analytics

2.3 Communicate with You
• Send appointment reminders
• Provide order status updates
• Respond to your inquiries
• Send promotional offers (with consent)
• Notify about policy changes

2.4 Security and Legal Compliance
• Prevent fraud and unauthorized access
• Enforce our Terms of Service
• Comply with legal obligations
• Protect our rights and property
• Respond to legal requests

3. HOW WE SHARE YOUR INFORMATION

3.1 Service Providers
We share information with trusted third parties who help us operate our services:
• Payment processors (Razorpay)
• Cloud storage providers (AWS S3, Cloudinary)
• Delivery and logistics partners
• SMS and email service providers
• Analytics and monitoring tools

3.2 Healthcare Providers
Your medical information is shared with:
• Consulting dermatologists and doctors
• Medical staff involved in your treatment
• Only as necessary for providing healthcare services

3.3 Legal Requirements
We may disclose information when required by:
• Court orders or legal process
• Government or regulatory authorities
• Law enforcement agencies
• Protection of our legal rights

3.4 Business Transfers
In the event of a merger, acquisition, or sale of assets, your information may be transferred to the new entity.

3.5 With Your Consent
We may share information for other purposes with your explicit consent.

4. DATA SECURITY

We implement security measures to protect your information:
• Encryption of data in transit and at rest
• Secure authentication and access controls
• Regular security audits and updates
• Secure payment processing through PCI-compliant gateways
• Limited employee access to personal data
• Monitoring for unauthorized access

However, no method of transmission over the internet is 100% secure. We cannot guarantee absolute security.

5. DATA RETENTION

We retain your information for as long as:
• Your account is active
• Required to provide services
• Necessary for legal compliance
• Needed to resolve disputes
• Required for legitimate business purposes

Medical records are retained according to applicable healthcare regulations. You may request deletion of your account, subject to legal retention requirements.

6. YOUR RIGHTS AND CHOICES

6.1 Access and Update
You can access and update your personal information through the app's profile settings.

6.2 Data Portability
You may request a copy of your data in a portable format.

6.3 Deletion
You may request deletion of your account and data, subject to legal retention requirements.

6.4 Marketing Communications
You can opt out of promotional emails and notifications through app settings or by following unsubscribe links.

6.5 Location Data
You can disable location services through your device settings.

6.6 Cookies and Tracking
You can manage cookie preferences through your device settings, though this may affect app functionality.

7. CHILDREN'S PRIVACY

Our services are not intended for children under 18. We do not knowingly collect information from children. If we discover we have collected information from a child, we will delete it promptly.

8. THIRD-PARTY LINKS AND SERVICES

Our app may contain links to third-party websites or services. We are not responsible for the privacy practices of these third parties. Please review their privacy policies separately.

9. INTERNATIONAL DATA TRANSFERS

Your information may be transferred to and processed in countries other than your own. We ensure appropriate safeguards are in place for such transfers.

10. CHANGES TO THIS PRIVACY POLICY

We may update this Privacy Policy from time to time. Changes will be posted in the app with the updated "Last Updated" date. Your continued use after changes constitutes acceptance of the updated policy.

11. CALIFORNIA PRIVACY RIGHTS (CCPA)

If you are a California resident, you have additional rights:
• Right to know what personal information is collected
• Right to know if personal information is sold or disclosed
• Right to opt out of the sale of personal information
• Right to request deletion of personal information
• Right to non-discrimination for exercising your rights

We do not sell your personal information.

12. GDPR RIGHTS (European Users)

If you are in the European Economic Area, you have rights under GDPR:
• Right to access your personal data
• Right to rectification of inaccurate data
• Right to erasure ("right to be forgotten")
• Right to restrict processing
• Right to data portability
• Right to object to processing
• Right to withdraw consent
• Right to lodge a complaint with supervisory authorities

13. MEDICAL INFORMATION PRIVACY

We comply with applicable healthcare privacy laws and regulations regarding the collection, use, and disclosure of protected health information. Your medical information is handled with the highest level of confidentiality.

14. CONSENT

By using our services, you consent to the collection, use, and sharing of your information as described in this Privacy Policy.

15. CONTACT US

For questions, concerns, or requests regarding your privacy or this policy, please contact us at:

Zennara Clinic
Privacy Officer
Email: privacy@zennaraclinic.com
Phone: [Contact Number]
Address: [Clinic Address]

Data Protection Officer: [Name]
Email: dpo@zennaraclinic.com

We will respond to your requests within 30 days as required by applicable law.

16. ACCOUNTABILITY

We maintain records of our data processing activities and regularly review our privacy practices to ensure compliance with this policy and applicable laws.

Thank you for trusting Zennara Clinic with your information. We are committed to protecting your privacy and providing you with excellent care.`
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
  // Define which fields are nested objects vs root-level fields
  const nestedObjectFields = ['homeScreen', 'consultationsScreen', 'appointmentsScreen', 'productsScreen', 'profileScreen'];
  
  // Deep merge updates
  Object.keys(updates).forEach(field => {
    if (nestedObjectFields.includes(field) && updates[field] && typeof updates[field] === 'object') {
      // Handle nested objects (homeScreen, consultationsScreen, etc.)
      Object.keys(updates[field]).forEach(subField => {
        this[field][subField] = updates[field][subField];
      });
    } else {
      // Handle root-level fields (appLogo, termsOfService, privacyPolicy, etc.)
      this[field] = updates[field];
    }
  });

  this.lastUpdatedBy = adminId;
  this.lastUpdatedAt = new Date();
  this.version += 1;

  await this.save();
  return this;
};

module.exports = mongoose.model('AppCustomization', appCustomizationSchema);
