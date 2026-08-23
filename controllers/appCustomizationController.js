const AppCustomization = require('../models/AppCustomization');
const { uploadToS3, uploadRawToS3, deleteFromS3 } = require('../services/s3Service');
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
    console.log('📸 Image upload request received:', {
      imageType: req.params.imageType,
      hasFile: !!req.file,
      fileName: req.file?.originalname,
      fileSize: req.file?.size,
      adminEmail: req.admin?.email
    });

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No image file provided'
      });
    }

    const { imageType } = req.params; // appLogo, heroBanner, zenMembershipCard
    
    // Validate image type
    if (!['appLogo', 'heroBanner', 'zenMembershipCard'].includes(imageType)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid image type. Must be appLogo, heroBanner, or zenMembershipCard'
      });
    }

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

    console.log('📤 Uploading to S3...');
    // Upload new image to S3
    const imageUrl = await uploadToS3(req.file, 'app-customization');
    console.log('✅ S3 upload successful:', imageUrl);

    // Update settings with new image URL
    const updates = {};
    if (imageType === 'appLogo') {
      updates.appLogo = imageUrl;
    } else if (imageType === 'heroBanner') {
      updates.homeScreen = { heroBannerImage: imageUrl };
    } else if (imageType === 'zenMembershipCard') {
      updates.homeScreen = { zenMembershipCardImage: imageUrl };
    }

    console.log('💾 Updating settings...');
    await settings.updateSettings(updates, req.admin._id);
    console.log('✅ Settings updated successfully');

    // Delete old image from S3 (if not default)
    if (oldImageUrl && !oldImageUrl.includes('cloudinary.com') && !oldImageUrl.includes('default-hero-banner')) {
      try {
        console.log('🗑️ Deleting old image:', oldImageUrl);
        await deleteFromS3(oldImageUrl);
      } catch (deleteError) {
        console.error('⚠️ Error deleting old image:', deleteError);
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
        oldImageUrl,
        description: `Uploaded ${imageType} image`
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent')
    });

    console.log('✅ Logo upload complete:', imageType);

    res.status(200).json({
      success: true,
      message: 'Image uploaded successfully',
      imageUrl,
      data: settings
    });
  } catch (error) {
    console.error('❌ Error uploading customization image:', error);
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
    
    // Rebuild every copy field from the schema's own defaults, so a reset can
    // never drift from what a fresh install shows. Uploaded media — logo,
    // banners, reels — is the clinic's content, not "settings", and is kept.
    const defaults = new AppCustomization().toObject();
    const keepHome = {
      heroBannerImage: settings.homeScreen?.heroBannerImage,
      zenMembershipCardImage: settings.homeScreen?.zenMembershipCardImage,
      consultationCategoryCards: settings.homeScreen?.consultationCategoryCards || [],
      reels: settings.homeScreen?.reels || [],
      reelVideos: settings.homeScreen?.reelVideos || [],
    };
    settings.homeScreen = { ...defaults.homeScreen, ...keepHome };
    settings.consultationsScreen = defaults.consultationsScreen;
    settings.appointmentsScreen = defaults.appointmentsScreen;
    settings.productsScreen = defaults.productsScreen;
    settings.profileScreen = defaults.profileScreen;

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


// @desc    Add a self-hosted reel video to the home rail
// @route   POST /api/app-customization/admin/reel-videos   (multipart: video, optional poster, permalink, title)
// @access  Private (Admin)
exports.addReelVideo = async (req, res) => {
  try {
    const video = req.files?.video?.[0];
    const poster = req.files?.poster?.[0];
    if (!video) {
      return res.status(400).json({ success: false, message: 'No video file provided' });
    }
    if (!video.mimetype.startsWith('video/')) {
      return res.status(400).json({ success: false, message: 'The reel must be a video file (MP4 recommended)' });
    }

    const settings = await AppCustomization.getSettings();
    const url = await uploadRawToS3(video, 'reels');
    const posterUrl = poster ? await uploadToS3(poster, 'reels') : '';

    const entry = {
      url,
      poster: posterUrl,
      permalink: String(req.body.permalink || '').trim(),
      title: String(req.body.title || '').trim(),
    };
    const list = [entry, ...(settings.homeScreen.reelVideos || [])];
    await settings.updateSettings({ homeScreen: { reelVideos: list } }, req.admin._id);

    return res.status(201).json({ success: true, message: 'Reel added', data: settings });
  } catch (error) {
    console.error('Add reel video error:', error);
    return res.status(500).json({ success: false, message: 'Failed to add reel', error: error.message });
  }
};

// @desc    Remove a self-hosted reel video (and its files)
// @route   DELETE /api/app-customization/admin/reel-videos/:reelId
// @access  Private (Admin)
exports.deleteReelVideo = async (req, res) => {
  try {
    const settings = await AppCustomization.getSettings();
    const list = settings.homeScreen.reelVideos || [];
    const entry = list.find((r) => String(r._id) === req.params.reelId);
    if (!entry) {
      return res.status(404).json({ success: false, message: 'Reel not found' });
    }
    await settings.updateSettings(
      { homeScreen: { reelVideos: list.filter((r) => String(r._id) !== req.params.reelId) } },
      req.admin._id
    );
    for (const fileUrl of [entry.url, entry.poster]) {
      if (fileUrl) {
        try { await deleteFromS3(fileUrl); } catch (e) { console.error('Reel file delete failed:', e.message); }
      }
    }
    return res.status(200).json({ success: true, message: 'Reel removed', data: settings });
  } catch (error) {
    console.error('Delete reel video error:', error);
    return res.status(500).json({ success: false, message: 'Failed to remove reel', error: error.message });
  }
};
