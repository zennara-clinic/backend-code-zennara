const AppCustomization = require('../models/AppCustomization');
const { uploadToS3, deleteFromS3 } = require('../services/s3Service');
const AdminAuditLog = require('../models/AdminAuditLog');

// @desc    Get app customization settings
// @route   GET /api/app-customization
// @access  Public (for mobile app)
exports.getCustomizationSettings = async (req, res) => {
  try {
    const settings = await AppCustomization.getSettings();
    
    res.status(200).json({
      success: true,
      data: settings,
      version: settings.version
    });
  } catch (error) {
    console.error('Error fetching app customization settings:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch customization settings',
      error: error.message
    });
  }
};

// @desc    Get app customization settings (Admin)
// @route   GET /api/admin/app-customization
// @access  Private (Admin only)
exports.getAdminCustomizationSettings = async (req, res) => {
  try {
    const settings = await AppCustomization.getSettings();
    
    res.status(200).json({
      success: true,
      data: settings
    });
  } catch (error) {
    console.error('Error fetching app customization settings:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch customization settings',
      error: error.message
    });
  }
};

// @desc    Update app customization settings
// @route   PUT /api/admin/app-customization
// @access  Private (Admin only)
exports.updateCustomizationSettings = async (req, res) => {
  try {
    const settings = await AppCustomization.getSettings();
    const updates = req.body;

    // Update settings using the model method
    await settings.updateSettings(updates, req.admin._id);

    // Log the action
    await AdminAuditLog.logAction({
      adminId: req.admin._id,
      adminEmail: req.admin.email,
      action: 'SETTINGS_UPDATED',
      resource: 'SETTINGS',
      resourceId: settings._id.toString(),
      details: {
        updatedFields: Object.keys(updates),
        description: 'Updated app customization settings'
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent')
    });

    res.status(200).json({
      success: true,
      message: 'App customization settings updated successfully',
      data: settings
    });
  } catch (error) {
    console.error('Error updating app customization settings:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update customization settings',
      error: error.message
    });
  }
};

// @desc    Upload image for app customization
// @route   POST /api/admin/app-customization/upload/:imageType
// @access  Private (Admin only)
exports.uploadCustomizationImage = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No image file provided'
      });
    }

    const { imageType } = req.params; // appLogo, heroBanner, zenMembershipCard
    const settings = await AppCustomization.getSettings();

    // Delete old image from S3 if exists
    let oldImageUrl = null;
    if (imageType === 'appLogo' && settings.appLogo) {
      oldImageUrl = settings.appLogo;
    } else if (imageType === 'heroBanner' && settings.homeScreen.heroBannerImage) {
      oldImageUrl = settings.homeScreen.heroBannerImage;
    } else if (imageType === 'zenMembershipCard' && settings.homeScreen.zenMembershipCardImage) {
      oldImageUrl = settings.homeScreen.zenMembershipCardImage;
    }

    // Upload new image to S3
    const imageUrl = await uploadToS3(req.file, 'app-customization');

    // Update settings with new image URL
    const updates = {};
    if (imageType === 'appLogo') {
      updates.appLogo = imageUrl;
    } else if (imageType === 'heroBanner') {
      updates.homeScreen = { heroBannerImage: imageUrl };
    } else if (imageType === 'zenMembershipCard') {
      updates.homeScreen = { zenMembershipCardImage: imageUrl };
    } else {
      return res.status(400).json({
        success: false,
        message: 'Invalid image type'
      });
    }

    await settings.updateSettings(updates, req.admin._id);

    // Delete old image from S3 (if not default)
    if (oldImageUrl && !oldImageUrl.includes('default-hero-banner')) {
      try {
        await deleteFromS3(oldImageUrl);
      } catch (deleteError) {
        console.error('Error deleting old image:', deleteError);
      }
    }

    // Log the action
    await AdminAuditLog.logAction({
      adminId: req.admin._id,
      adminEmail: req.admin.email,
      action: 'SETTINGS_UPDATED',
      resource: 'SETTINGS',
      resourceId: settings._id.toString(),
      details: {
        imageType,
        imageUrl,
        description: `Uploaded ${imageType} image`
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent')
    });

    res.status(200).json({
      success: true,
      message: 'Image uploaded successfully',
      imageUrl,
      data: settings
    });
  } catch (error) {
    console.error('Error uploading customization image:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to upload image',
      error: error.message
    });
  }
};

// @desc    Reset app customization settings to default
// @route   POST /api/admin/app-customization/reset
// @access  Private (Admin only)
exports.resetCustomizationSettings = async (req, res) => {
  try {
    const settings = await AppCustomization.getSettings();
    
    // Reset to default values
    settings.appLogo = 'https://res.cloudinary.com/dgcpuirdo/image/upload/v1749817496/zennara_logo_wtk8lz.png';
    settings.homeScreen = {
      heroBannerImage: 'https://zennara-bucket.s3.ap-south-1.amazonaws.com/default-hero-banner.jpg',
      heroBannerRoute: 'consultations',
      consultationsButtonText: 'Book Consultation',
      productsButtonText: 'Shop Products',
      consultationCategoryCards: [
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
      ],
      consultationsSectionHeading: 'Consultations',
      consultationsSectionButtonText: 'See All',
      popularConsultationsSectionHeading: 'Popular Consultations',
      popularConsultationsSectionButtonText: 'See All',
      popularProductsSectionHeading: 'Popular Products',
      popularProductsSectionButtonText: 'See All',
      zenMembershipCardImage: null,
      zenMembershipCardTitle: 'Zen Membership',
      zenMembershipCardDescription: 'Unlock exclusive benefits and save more'
    };

    settings.consultationsScreen = {
      heading: 'Consultations',
      subHeading: 'Book your consultation with our expert dermatologists',
      searchbarPlaceholder: 'Search consultations...'
    };

    settings.appointmentsScreen = {
      heading: 'My Appointments',
      subHeading: 'View and manage your upcoming appointments'
    };

    settings.productsScreen = {
      heading: 'Products',
      subHeading: 'Discover our curated skincare collection',
      searchbarPlaceholder: 'Search products...'
    };

    settings.profileScreen = {
      heading: 'Profile',
      subHeading: 'Manage your account and preferences',
      searchbarPlaceholder: 'Search settings...',
      membershipCardText: 'Zen Membership',
      ordersCardText: 'My Orders',
      appointmentsCardText: 'My Appointments',
      addressesCardText: 'Saved Addresses'
    };

    settings.lastUpdatedBy = req.admin._id;
    settings.lastUpdatedAt = new Date();
    settings.version += 1;

    await settings.save();

    // Log the action
    await AdminAuditLog.logAction({
      adminId: req.admin._id,
      adminEmail: req.admin.email,
      action: 'SETTINGS_UPDATED',
      resource: 'SETTINGS',
      resourceId: settings._id.toString(),
      details: {
        description: 'Reset app customization settings to default'
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent')
    });

    res.status(200).json({
      success: true,
      message: 'App customization settings reset to default',
      data: settings
    });
  } catch (error) {
    console.error('Error resetting app customization settings:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to reset customization settings',
      error: error.message
    });
  }
};

// @desc    Add consultation category card
// @route   POST /api/admin/app-customization/consultation-card
// @access  Private (Admin only)
exports.addConsultationCard = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No image file provided'
      });
    }

    const { categoryName, searchTerm, displayOrder } = req.body;

    if (!categoryName || !searchTerm) {
      return res.status(400).json({
        success: false,
        message: 'Category name and search term are required'
      });
    }

    const settings = await AppCustomization.getSettings();

    // Upload image to S3
    const imageUrl = await uploadToS3(req.file, 'app-customization/consultation-cards');

    // Add new card
    const newCard = {
      image: imageUrl,
      categoryName,
      searchTerm,
      displayOrder: displayOrder || settings.homeScreen.consultationCategoryCards.length + 1
    };

    settings.homeScreen.consultationCategoryCards.push(newCard);
    settings.lastUpdatedBy = req.admin._id;
    settings.lastUpdatedAt = new Date();
    settings.version += 1;

    await settings.save();

    // Log the action
    await AdminAuditLog.logAction({
      adminId: req.admin._id,
      adminEmail: req.admin.email,
      action: 'SETTINGS_UPDATED',
      resource: 'SETTINGS',
      resourceId: settings._id.toString(),
      details: {
        categoryName,
        imageUrl,
        description: `Added consultation category card: ${categoryName}`
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent')
    });

    res.status(200).json({
      success: true,
      message: 'Consultation category card added successfully',
      data: settings
    });
  } catch (error) {
    console.error('Error adding consultation category card:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add consultation category card',
      error: error.message
    });
  }
};

// @desc    Update consultation category card
// @route   PUT /api/admin/app-customization/consultation-card/:cardId
// @access  Private (Admin only)
exports.updateConsultationCard = async (req, res) => {
  try {
    const { cardId } = req.params;
    const { categoryName, searchTerm, displayOrder } = req.body;

    const settings = await AppCustomization.getSettings();
    const card = settings.homeScreen.consultationCategoryCards.id(cardId);

    if (!card) {
      return res.status(404).json({
        success: false,
        message: 'Consultation category card not found'
      });
    }

    let imageUrl = card.image;

    // If new image is provided, upload it and delete old one
    if (req.file) {
      const oldImageUrl = card.image;
      imageUrl = await uploadToS3(req.file, 'app-customization/consultation-cards');
      
      // Delete old image
      if (oldImageUrl) {
        try {
          await deleteFromS3(oldImageUrl);
        } catch (deleteError) {
          console.error('Error deleting old image:', deleteError);
        }
      }
    }

    // Update card
    card.image = imageUrl;
    if (categoryName) card.categoryName = categoryName;
    if (searchTerm) card.searchTerm = searchTerm;
    if (displayOrder !== undefined) card.displayOrder = displayOrder;

    settings.lastUpdatedBy = req.admin._id;
    settings.lastUpdatedAt = new Date();
    settings.version += 1;

    await settings.save();

    // Log the action
    await AdminAuditLog.logAction({
      adminId: req.admin._id,
      adminEmail: req.admin.email,
      action: 'SETTINGS_UPDATED',
      resource: 'SETTINGS',
      resourceId: settings._id.toString(),
      details: {
        cardId,
        categoryName: card.categoryName,
        description: `Updated consultation category card: ${card.categoryName}`
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent')
    });

    res.status(200).json({
      success: true,
      message: 'Consultation category card updated successfully',
      data: settings
    });
  } catch (error) {
    console.error('Error updating consultation category card:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update consultation category card',
      error: error.message
    });
  }
};

// @desc    Delete consultation category card
// @route   DELETE /api/admin/app-customization/consultation-card/:cardId
// @access  Private (Admin only)
exports.deleteConsultationCard = async (req, res) => {
  try {
    const { cardId } = req.params;
    const settings = await AppCustomization.getSettings();
    const card = settings.homeScreen.consultationCategoryCards.id(cardId);

    if (!card) {
      return res.status(404).json({
        success: false,
        message: 'Consultation category card not found'
      });
    }

    const oldImageUrl = card.image;
    const categoryName = card.categoryName;

    // Remove card
    settings.homeScreen.consultationCategoryCards.pull(cardId);
    settings.lastUpdatedBy = req.admin._id;
    settings.lastUpdatedAt = new Date();
    settings.version += 1;

    await settings.save();

    // Delete image from S3
    if (oldImageUrl) {
      try {
        await deleteFromS3(oldImageUrl);
      } catch (deleteError) {
        console.error('Error deleting image:', deleteError);
      }
    }

    // Log the action
    await AdminAuditLog.logAction({
      adminId: req.admin._id,
      adminEmail: req.admin.email,
      action: 'SETTINGS_UPDATED',
      resource: 'SETTINGS',
      resourceId: settings._id.toString(),
      details: {
        cardId,
        categoryName,
        description: `Deleted consultation category card: ${categoryName}`
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent')
    });

    res.status(200).json({
      success: true,
      message: 'Consultation category card deleted successfully',
      data: settings
    });
  } catch (error) {
    console.error('Error deleting consultation category card:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete consultation category card',
      error: error.message
    });
  }
};
