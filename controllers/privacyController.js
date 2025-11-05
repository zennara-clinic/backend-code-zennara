// @desc    Privacy Policy and Terms of Service Content
// Compliant with DPDPA 2023, IT Act 2000, and Clinical Establishments Act

// @desc    Get Privacy Policy
// @route   GET /api/privacy/policy
// @access  Public
exports.getPrivacyPolicy = async (req, res) => {
  try {
    const privacyPolicy = {
      version: '1.0',
      effectiveDate: '2024-01-01',
      lastUpdated: new Date().toISOString(),
      content: {
        introduction: {
          title: 'Privacy Policy',
          text: 'Zennara ("we", "our", or "us") is committed to protecting your privacy and personal data in compliance with the Digital Personal Data Protection Act (DPDPA) 2023, Information Technology Act 2000, and Clinical Establishments Act.'
        },
        dataCollection: {
          title: 'Data We Collect',
          personalData: [
            'Name, email address, phone number',
            'Date of birth and gender',
            'Location (city-level only)',
            'Profile picture (optional)',
            'Delivery addresses'
          ],
          healthData: [
            'Medical history (diabetes, hypertension, thyroid conditions)',
            'Skin and hair concerns',
            'Allergies and medications',
            'Menstrual cycle information (if applicable)',
            'Treatment preferences and consultation notes'
          ],
          technicalData: [
            'Device information and IP address',
            'App usage statistics',
            'Login history and security logs'
          ],
          financialData: [
            'Payment transaction details (processed securely through Razorpay)',
            'Purchase history and order details'
          ]
        },
        dataUsage: {
          title: 'How We Use Your Data',
          purposes: [
            'Providing medical consultations and treatments',
            'Processing appointments and orders',
            'Sending appointment reminders and updates',
            'Improving our services and user experience',
            'Complying with legal and regulatory requirements',
            'Preventing fraud and ensuring security'
          ]
        },
        dataSharing: {
          title: 'Data Sharing',
          text: 'We do NOT sell your personal data. We may share your data only with:',
          parties: [
            'Healthcare professionals for your treatment',
            'Payment processors (Razorpay) for transactions',
            'Cloud service providers (AWS, Cloudinary) for secure storage',
            'Legal authorities when required by law'
          ]
        },
        dataRetention: {
          title: 'Data Retention',
          text: 'We retain your data for 3 years as required by the Clinical Establishments Act. Health records may be retained longer for medical and legal compliance.'
        },
        yourRights: {
          title: 'Your Rights (DPDPA 2023)',
          rights: [
            'Right to Access: Request a copy of your data',
            'Right to Correction: Update or correct your information',
            'Right to Erasure: Delete your account and data',
            'Right to Data Portability: Export your data in a readable format',
            'Right to Withdraw Consent: Opt-out of non-essential communications',
            'Right to Grievance Redressal: File complaints about data handling'
          ]
        },
        dataSecurity: {
          title: 'Data Security',
          measures: [
            'HTTPS/TLS encryption for data transmission',
            'Secure storage with access controls',
            'Regular security audits and monitoring',
            'OTP-based authentication',
            'Automatic session timeout after inactivity'
          ]
        },
        consentManagement: {
          title: 'Consent Management',
          text: 'By using our services, you explicitly consent to the collection and processing of your personal and health data as described in this policy. You can withdraw consent at any time by deleting your account, subject to legal retention requirements.'
        },
        grievanceOfficer: {
          title: 'Grievance Officer',
          text: 'For any privacy concerns or complaints, contact our Data Protection Officer:',
          contact: {
            email: 'privacy@zennara.in',
            phone: '+91-XXX-XXX-XXXX',
            address: 'Hyderabad, India'
          }
        },
        changes: {
          title: 'Changes to This Policy',
          text: 'We may update this privacy policy from time to time. We will notify you of significant changes via email or app notification.'
        }
      }
    };

    res.status(200).json({
      success: true,
      data: privacyPolicy
    });
  } catch (error) {
    console.error('❌ Failed to fetch privacy policy:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch privacy policy'
    });
  }
};

// @desc    Get Terms of Service
// @route   GET /api/privacy/terms
// @access  Public
exports.getTermsOfService = async (req, res) => {
  try {
    const termsOfService = {
      version: '1.0',
      effectiveDate: '2024-01-01',
      lastUpdated: new Date().toISOString(),
      content: {
        introduction: {
          title: 'Terms of Service',
          text: 'Welcome to Zennara. By using our app and services, you agree to these Terms of Service and our Privacy Policy.'
        },
        eligibility: {
          title: 'Eligibility',
          text: 'You must be at least 18 years old to use our services. By registering, you confirm that you are legally capable of entering into binding contracts.'
        },
        services: {
          title: 'Our Services',
          description: 'Zennara provides:',
          list: [
            'Dermatology and wellness consultations',
            'Treatment booking and management',
            'Health product orders and delivery',
            'Membership programs (Regular and Zen Member)'
          ]
        },
        userResponsibilities: {
          title: 'Your Responsibilities',
          responsibilities: [
            'Provide accurate and truthful information',
            'Maintain confidentiality of your account credentials',
            'Inform us of any changes to your health status',
            'Attend scheduled appointments or cancel in advance',
            'Use services only for lawful purposes'
          ]
        },
        medicalDisclaimer: {
          title: 'Medical Disclaimer',
          text: 'Our services are provided by licensed healthcare professionals. However, in-app information is for general guidance only and does not replace professional medical advice. Always consult with qualified healthcare providers for specific medical concerns.'
        },
        payment: {
          title: 'Payments and Refunds',
          text: 'Payments are processed securely through Razorpay. Refund policies vary by service type. Please refer to our specific refund policy for treatments and product orders.'
        },
        cancellation: {
          title: 'Appointment Cancellation',
          text: 'You may cancel appointments up to 24 hours before the scheduled time. Late cancellations may be subject to charges.'
        },
        intellectualProperty: {
          title: 'Intellectual Property',
          text: 'All content, trademarks, and materials on the Zennara app are owned by Zennara or its licensors. You may not reproduce, distribute, or create derivative works without permission.'
        },
        liability: {
          title: 'Limitation of Liability',
          text: 'Zennara is not liable for indirect, incidental, or consequential damages arising from use of our services, except as required by law.'
        },
        termination: {
          title: 'Account Termination',
          text: 'We reserve the right to suspend or terminate accounts that violate these terms. You may delete your account at any time through the app settings.'
        },
        governingLaw: {
          title: 'Governing Law',
          text: 'These terms are governed by the laws of India. Any disputes shall be subject to the exclusive jurisdiction of courts in Hyderabad, Telangana.'
        },
        contact: {
          title: 'Contact Us',
          text: 'For questions about these terms, contact us at:',
          email: 'support@zennara.in',
          phone: '+91-XXX-XXX-XXXX'
        }
      }
    };

    res.status(200).json({
      success: true,
      data: termsOfService
    });
  } catch (error) {
    console.error('❌ Failed to fetch terms of service:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch terms of service'
    });
  }
};

// @desc    Get Health Data Consent Form
// @route   GET /api/privacy/health-consent
// @access  Public
exports.getHealthDataConsent = async (req, res) => {
  try {
    const healthConsent = {
      version: '1.0',
      title: 'Health Data Collection Consent',
      content: {
        introduction: 'Before we collect your health information, we need your explicit consent as required by DPDPA 2023 and IT Act 2000.',
        dataCollected: [
          'Medical history (existing conditions)',
          'Current medications and allergies',
          'Skin and hair concerns',
          'Lifestyle information (diet, exercise)',
          'Menstrual cycle data (if applicable)',
          'Photos of affected areas (if provided)'
        ],
        purpose: 'This information will be used solely for:',
        purposes: [
          'Providing accurate diagnosis and treatment',
          'Personalizing your treatment plan',
          'Tracking treatment progress',
          'Ensuring your safety during procedures'
        ],
        dataHandling: {
          access: 'Only authorized healthcare professionals will access your health data.',
          storage: 'Data is stored securely with encryption and access controls.',
          retention: 'Health records are retained for 3 years as per Clinical Establishments Act.',
          sharing: 'Health data will NOT be shared with third parties without your consent, except as required by law.'
        },
        yourRights: [
          'You can access your health records at any time',
          'You can request corrections to inaccurate information',
          'You can withdraw consent and delete your data (subject to legal retention)',
          'You can file complaints with our Data Protection Officer'
        ],
        consentText: 'I consent to the collection, storage, and processing of my health information for medical treatment purposes as per DPDPA 2023 and Clinical Establishments Act.'
      }
    };

    res.status(200).json({
      success: true,
      data: healthConsent
    });
  } catch (error) {
    console.error('❌ Failed to fetch health consent:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch health consent'
    });
  }
};
